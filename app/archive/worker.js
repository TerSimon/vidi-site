// Распаковка архива КТ в браузере без загрузки его в память целиком.
//
// ZIP читает zip.js — кусками через BlobReader, распаковка встроенным
// DecompressionStream. Всё остальное (RAR, RAR5, 7z, tar, gz) — 7-Zip в WASM:
// архив подключается через WORKERFS, который читает File срезами прямо с диска.
//
// Память — главное ограничение телефона, поэтому распакованные данные идут не в
// файловую систему, а в Sink. Он смотрит на первые 512 байт файла и решает:
// DICOM и вложенные архивы собираются в один буфер заранее известного размера,
// всё остальное (программы-просмотрщики, их библиотеки) только считается и
// выбрасывается по мере распаковки.
//
// Наружу уходят только числа. Имена файлов и текст ошибок 7-Zip не передаются:
// в архивах КТ в них часто стоит фамилия пациента.
//
// У каждого найденного DICOM читается заголовок, после чего файл отпускается:
// держать в памяти весь распакованный архив нельзя — это сотни мегабайт сверх
// объёма КТ, который ещё предстоит построить. Из заголовков собирается опись
// серий; пиксели заливаются в объём вторым проходом, уже зная геометрию.
//
// Имя пациента из заголовка на страницу уходит — врач должен видеть, чей
// снимок открыт. Устройство оно при этом не покидает: страница ничего не
// отправляет. А вот имена файлов остаются здесь: в них та же фамилия, и в
// интерфейсе они не нужны.

import './vendor/zip.min.js';
import SevenZip from './vendor/7zz.es6.js';
import { readDicomHeader } from './dicom.js?v=0.4.3';

const zip = globalThis.zip;
zip.configure({ useWebWorkers: false });

const MAX_DEPTH = 4;

// Размер памяти последнего экземпляра 7-Zip: Emscripten её наружу не отдаёт,
// поэтому запоминаем память каждого созданного WASM-экземпляра.
let lastWasmMemory = null;
for (const name of ['instantiate', 'instantiateStreaming']) {
  const original = WebAssembly[name];
  WebAssembly[name] = async (...args) => {
    const result = await original.apply(WebAssembly, args);
    lastWasmMemory = (result.instance ?? result).exports?.memory ?? lastWasmMemory;
    return result;
  };
}
const lastWasmHeapMB = () => Math.round((lastWasmMemory?.buffer.byteLength ?? 0) / 1048576);
const HEAD = 512;

let stats;
let lastPost = 0;

function newStats() {
  return {
    format: '',
    files: 0,
    entriesTotal: 0,
    dicom: 0,
    dicomBytes: 0,
    truncated: 0,
    unreadable: 0,
    indexFiles: 0,
    duplicates: 0,
    other: 0,
    nested: 0,
    encrypted: 0,
    bytesOut: 0,
    keptBytes: 0,
    largestFile: 0,
    largestKept: 0,
    wasmHeapMB: 0,
    sevenZipRuns: 0,
    readCalls: 0,
    readBytes: 0,
    readMs: 0,
    wasmInitMs: 0,
    listMs: 0,
    extractMs: 0,
    nestedMs: 0,
    firstFileMs: null,
    startedAt: performance.now(),
  };
}

function post(type, extra = {}) {
  const payload = { type, stats: { ...stats, elapsedMs: performance.now() - stats.startedAt }, ...extra };
  if (fill) payload.fill = { filled: fill.filled, total: fill.out.d };
  self.postMessage(payload);
}

// Только для замера на Mac (Chrome с --js-flags=--expose-gc): сборка мусора
// после каждых нескольких файлов показывает, сколько памяти занято на самом деле.
let debugGc = false;

function tick() {
  if (debugGc && stats.files % 10 === 0) globalThis.gc?.();
  const now = performance.now();
  if (now - lastPost > 250) {
    lastPost = now;
    post('progress');
  }
}

function startsWith(bytes, sig, offset = 0) {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

// Формат по сигнатуре, не по расширению: у архивов из клиник расширение бывает любым.
function detect(head) {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])) return 'rar5';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])) return 'rar';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(head, [0x1f, 0x8b])) return 'gz';
  if (startsWith(head, [0x42, 0x5a, 0x68])) return 'bz2';
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (startsWith(head, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return 'tar';
  if (startsWith(head, [0x44, 0x49, 0x43, 0x4d], 128)) return 'dicom';
  return 'unknown';
}

const isArchive = (kind) => kind !== 'dicom' && kind !== 'unknown';

// Приёмник одного распакованного файла. expected — размер из оглавления архива;
// ему не доверяем вслепую: если данных приходит больше, переходим на куски.
class Sink {
  constructor(expected, keepArchives = true) {
    this.keepArchives = keepArchives;
    this.expected = Number.isFinite(expected) && expected > 0 ? expected : 0;
    this.head = new Uint8Array(HEAD);
    this.headLen = 0;
    this.kind = null;
    this.size = 0;
    this.buffer = null;
    this.chunks = null;
  }

  write(bytes) {
    let data = bytes;
    if (this.kind === null) {
      const take = Math.min(HEAD - this.headLen, data.length);
      this.head.set(data.subarray(0, take), this.headLen);
      this.headLen += take;
      this.size += take;
      data = data.subarray(take);
      if (this.headLen < HEAD) return;
      this.decide();
    }
    if (data.length === 0) return;
    const from = this.size;
    this.size += data.length;
    if (!this.keep) return;
    if (this.buffer && this.size <= this.buffer.length) {
      this.buffer.set(data, from);
      return;
    }
    if (this.buffer) {
      // Оглавление соврало о размере: всё, что уже есть, становится первым куском.
      this.chunks = [this.buffer.subarray(0, from)];
      this.buffer = null;
    }
    this.chunks.push(data.slice());
  }

  decide() {
    this.kind = detect(this.head.subarray(0, this.headLen));
    this.keep = this.kind === 'dicom' || (isArchive(this.kind) && this.keepArchives);
    if (!this.keep) return;
    if (this.expected >= this.headLen) {
      this.buffer = new Uint8Array(this.expected);
      this.buffer.set(this.head.subarray(0, this.headLen));
    } else {
      this.chunks = [this.head.slice(0, this.headLen)];
    }
  }

  // Возвращает { kind, size, bytes }; bytes есть только у сохраняемых файлов.
  finish() {
    if (this.kind === null) this.decide();
    let bytes = null;
    if (this.keep) {
      if (this.buffer) {
        bytes = this.buffer.subarray(0, this.size);
      } else {
        bytes = new Uint8Array(this.size);
        let at = 0;
        for (const chunk of this.chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
      }
    }
    this.buffer = this.chunks = null;
    return { kind: this.kind, size: this.size, bytes };
  }
}

// Учёт одного файла. Возвращает вложенный архив, чтобы разобрать его после
// текущего: рекурсия внутри callMain 7-Zip невозможна.
function account({ kind, size, bytes }) {
  if (size === 0) return null;
  stats.files++;
  stats.bytesOut += size;
  if (size > stats.largestFile) stats.largestFile = size;
  if (stats.firstFileMs === null) stats.firstFileMs = performance.now() - stats.startedAt;
  if (bytes) {
    stats.keptBytes += size;
    if (size > stats.largestKept) stats.largestKept = size;
  }
  if (kind === 'dicom') {
    stats.dicom++;
    stats.dicomBytes += size;
    handleDicom(bytes, size);
    return null;
  }
  if (isArchive(kind)) {
    stats.nested++;
    return bytes;
  }
  stats.other++;
  return null;
}

// Опись: серии по SeriesInstanceUID, внутри — срезы без повторов.
let study;

function newStudy() {
  return { patientName: '', patientID: '', studyDate: '', studyUID: '', series: new Map() };
}

/**
 * Заголовок прочитан — данные снимка больше не нужны. Ссылку на bytes здесь не
 * сохраняем: как только функция вернулась, распакованный файл освобождается.
 */
function handleDicom(bytes, size) {
  if (!bytes || bytes.length === 0) return;
  if (fill) { fillSlice(bytes, size); return; }
  // 7-Zip может закрыть поток раньше времени; тогда «найден снимок» было бы
  // неправдой, и такой файл в опись не идёт.
  if (bytes.length < size) { stats.truncated++; return; }

  let h;
  try {
    h = readDicomHeader(bytes);
  } catch (e) {
    h = null;
  }
  if (!h) { stats.unreadable++; return; }
  // Оглавление архива — не срез: в опись оно не идёт и тревоги не вызывает.
  if (h.directory) { stats.indexFiles++; return; }

  if (!study.patientName && h.patientName) study.patientName = h.patientName;
  if (!study.patientID && h.patientID) study.patientID = h.patientID;
  if (!study.studyDate && h.studyDate) study.studyDate = h.studyDate;
  if (!study.studyUID && h.studyUID) study.studyUID = h.studyUID;

  // Серия без UID — своя на файл: склеивать такие в одну значит смешать
  // снимки разных исследований.
  const key = h.seriesUID || `no-uid-${stats.dicom}`;
  let series = study.series.get(key);
  if (!series) {
    series = {
      uid: key,
      description: h.seriesDescription,
      number: h.seriesNumber,
      imageType: h.imageType,
      rows: h.rows, columns: h.columns,
      bitsAllocated: h.bitsAllocated,
      signed: h.signed,
      samples: h.samples,
      monochrome1: h.monochrome1,
      compressed: h.compressed,
      transferSyntax: h.transferSyntax,
      pixelSpacing: h.pixelSpacing,
      sliceThickness: h.sliceThickness,
      orientation: h.orientation,
      slope: h.slope,
      intercept: h.intercept,
      sops: new Set(),
      slices: [],
    };
    study.series.set(key, series);
  }

  // Повтор того же SOP Instance UID — это один и тот же срез, пересохранённый
  // в архиве дважды. В объёме он стал бы лишним слоем.
  if (h.sopUID) {
    if (series.sops.has(h.sopUID)) { stats.duplicates++; return; }
    series.sops.add(h.sopUID);
  }

  series.slices.push({
    key: sliceKey(h),
    sop: h.sopUID,
    instance: h.instanceNumber,
    position: h.position,
    frames: h.frames,
    pixelAt: h.pixelAt,
    pixelLength: h.pixelLength,
  });
}

/**
 * Чем срез опознаётся во втором проходе. Имён файлов у нас нет и не будет —
 * в них фамилия пациента, — поэтому срез называет себя сам, своим UID из
 * заголовка. Экспорты без UID встречаются, для них остаётся номер в серии.
 */
function sliceKey(h) {
  if (h.sopUID) return h.sopUID;
  if (Number.isFinite(h.instanceNumber)) return 'i' + h.instanceNumber;
  return '';
}

// ─── Второй проход: объём ──────────────────────────────────────────────────
//
// Первый проход прочитал только заголовки — 587 МБ снимков в памяти телефона
// не удержать. Теперь, зная геометрию, архив читается второй раз, и пиксели
// выбранной серии ложатся сразу на своё место в объёме. В памяти при этом
// лежит один объём, а не объём плюс распакованный архив.
//
// Срез узнаётся по своему UID из заголовка, а не по имени файла: имён у нас
// нет намеренно.

let fill = null;

function startFill(plan) {
  const { columns, rows, slices, stepXY, stepZ } = plan;
  const w = Math.ceil(columns / stepXY);
  const h = Math.ceil(rows / stepXY);
  const d = Math.ceil(slices / stepZ);
  fill = {
    ...plan,
    out: { w, h, d },
    data: new Uint16Array(w * h * d),
    // Куда класть срез: ключ → номер в отсортированном порядке.
    index: new Map(plan.order.map((key, i) => [key, i])),
    placed: new Set(),
    // Для автоматического окна: гистограмма значений, 4096 корзин на весь
    // 16-битный размах. Считать её потом отдельным проходом по объёму — это
    // ещё 66 миллионов чтений, а здесь значения уже в руках.
    histogram: new Uint32Array(4096),
    filled: 0,
    skipped: 0,
  };
}

/** Кладёт пиксели одного среза в объём. */
function fillSlice(bytes, size) {
  if (bytes.length < size) { stats.truncated++; return; }
  let h;
  try { h = readDicomHeader(bytes); } catch (e) { h = null; }
  if (!h || h.directory) return;
  if (h.seriesUID !== fill.seriesUID) return;

  const at = fill.index.get(sliceKey(h));
  if (at === undefined) { fill.skipped++; return; }
  // Повтор того же среза: первый уже лёг, второй только затёр бы его собой.
  if (fill.placed.has(at)) return;
  if (at % fill.stepZ !== 0) { fill.placed.add(at); return; }
  const k = at / fill.stepZ;
  if (k >= fill.out.d) return;

  const need = h.rows * h.columns * 2;
  if (h.rows !== fill.rows || h.columns !== fill.columns ||
      h.bitsAllocated !== 16 || h.samples !== 1 || h.encapsulated ||
      h.pixelAt + need > bytes.length) {
    fill.skipped++;
    return;
  }

  const src = sourceView(bytes, h.pixelAt, h.rows * h.columns, h.bigEndian);
  const { w, h: oh } = fill.out;
  const step = fill.stepXY;
  const out = fill.data;
  const hist = fill.histogram;
  const signed = h.signed;
  const base = k * w * oh;

  for (let jo = 0; jo < oh; jo++) {
    const row = (jo * step) * h.columns;
    const dst = base + jo * w;
    for (let io = 0; io < w; io++) {
      const v = src[row + io * step];
      out[dst + io] = v;
      // Гистограмма по значению со знаком: у части аппаратов размах уходит
      // в минус, и окно по беззнаковому виду встало бы не туда.
      const d = signed && v >= 32768 ? v - 65536 : v;
      hist[(d + 32768) >> 4]++;
    }
  }

  fill.placed.add(at);
  fill.filled++;
  tick();
}

/**
 * Пиксели среза как 16-битные значения. Быстрый путь — без копии, прямо по
 * памяти файла; он требует чётного смещения и прямого порядка байт.
 */
function sourceView(bytes, at, count, bigEndian) {
  const start = bytes.byteOffset + at;
  if (!bigEndian && start % 2 === 0) {
    return new Uint16Array(bytes.buffer, start, count);
  }
  const view = new DataView(bytes.buffer, start, count * 2);
  const copy = new Uint16Array(count);
  for (let i = 0; i < count; i++) copy[i] = view.getUint16(i * 2, !bigEndian);
  return copy;
}

/** Насколько серия похожа на ту самую КТ, а не на служебный экспорт. */
function seriesRank(s) {
  let rank = 0;
  // 16 бит и много срезов — признак объёма, а не пары скриншотов, которые
  // Sidexis кладёт рядом и которые раньше открывались вместо исследования.
  if (s.bitsAllocated === 16) rank += 100;
  if (s.slices.length >= 10) rank += 100;
  if (/ORIGINAL/.test(s.imageType)) rank += 20;
  if (/PRIMARY/.test(s.imageType)) rank += 10;
  // Производные пересчёты (корональная, сагиттальная развёртка) бывают крупнее
  // исходной серии, но открывать надо исходную.
  if (/DERIVED|SECONDARY|REFORMAT/.test(s.imageType)) rank -= 40;
  return rank;
}

/** Опись для страницы: без множеств и без списков срезов. */
function studySummary() {
  const list = [...study.series.values()].map((s) => ({
    uid: s.uid,
    description: s.description,
    number: s.number,
    slices: s.slices.length,
    rows: s.rows,
    columns: s.columns,
    bitsAllocated: s.bitsAllocated,
    imageType: s.imageType,
    signed: s.signed,
    samples: s.samples,
    monochrome1: s.monochrome1,
    slope: s.slope,
    intercept: s.intercept,
    compressed: s.compressed,
    transferSyntax: s.transferSyntax,
    pixelSpacing: s.pixelSpacing,
    sliceThickness: s.sliceThickness,
    orientation: s.orientation,
    // План для второго прохода: чем срез себя назовёт и где он лежит.
    // Порядок здесь тот, в каком срезы попались в архиве; раскладывает их
    // по местам геометрия, по положению в пространстве.
    plan: s.slices.map((x) => ({ key: x.key, instance: x.instance, position: x.position })),
    rank: seriesRank(s),
  }));
  list.sort((a, b) => b.rank - a.rank || b.slices - a.slices);
  return {
    patientName: study.patientName,
    patientID: study.patientID,
    studyDate: study.studyDate,
    series: list,
  };
}

class SinkWriter extends zip.Writer {
  init(size) {
    super.init();
    this.sink = new Sink(size);
  }
  writeUint8Array(array) {
    this.sink.write(array);
  }
  getData() {
    return this.sink.finish();
  }
}

async function readZip(source, depth) {
  const reader = source instanceof Uint8Array
    ? new zip.Uint8ArrayReader(source)
    : new zip.BlobReader(source);
  const zipReader = new zip.ZipReader(reader, { checkSignature: true });
  try {
    const entries = await zipReader.getEntries();
    if (depth === 0) stats.entriesTotal = entries.filter((e) => !e.directory).length;
    for (const entry of entries) {
      if (entry.directory) continue;
      if (entry.encrypted) {
        stats.encrypted++;
        continue;
      }
      const result = await entry.getData(new SinkWriter(), { checkSignature: true });
      const inner = account(result);
      tick();
      // Вложенный архив разбираем сразу: иначе все вложенные копились бы в памяти
      // до конца внешнего архива.
      if (inner) await readAny(inner, depth + 1);
    }
  } finally {
    await zipReader.close();
  }
}

function sevenZipError(code) {
  if (code === 1) return 'warning';
  if (code === 2) return 'fatal';
  if (code === 7) return 'command';
  if (code === 8) return 'memory';
  return `code-${code}`;
}

async function newSevenZip(onLine) {
  const started = performance.now();
  const module = await SevenZip({
    locateFile: (path) => new URL(`./vendor/${path}`, import.meta.url).href,
    print: onLine ?? (() => {}),
    printErr: () => {},
  });
  stats.wasmInitMs += performance.now() - started;
  return module;
}

// Сколько читать с диска за раз. WORKERFS на каждое обращение 7-Zip делает
// отдельное синхронное чтение File; оглавление RAR — это тысячи мелких чтений
// заголовков по всему архиву, и на iPhone каждое такое чтение дорогое.
// Блок читается один раз, мелкие обращения обслуживаются из него.
let readAheadBytes = 16 * 1048576;

function mountArchive(module, blob, name) {
  const FS = module.FS;
  FS.mkdir('/in');
  // Новый File на тех же данных не копирует их: браузер хранит ссылку на исходный.
  FS.mount(module.WORKERFS, { files: [new File([blob], name)] }, '/in');

  const reader = new FileReaderSync();
  module.WORKERFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const node = stream.node;
    if (position >= node.size) return 0;
    const end = Math.min(node.size, position + length);
    let cache = node.vidiCache;
    if (!cache || position < cache.start || end > cache.start + cache.bytes.length) {
      const blockEnd = Math.min(node.size, position + Math.max(length, readAheadBytes));
      const started = performance.now();
      const block = reader.readAsArrayBuffer(node.contents.slice(position, blockEnd));
      stats.readMs += performance.now() - started;
      stats.readCalls++;
      stats.readBytes += block.byteLength;
      cache = { start: position, bytes: new Uint8Array(block) };
      node.vidiCache = cache;
    }
    buffer.set(cache.bytes.subarray(position - cache.start, end - cache.start), offset);
    return end - position;
  };
}

// Путь элемента так, как 7-Zip создаёт его при распаковке: без «./», с «/».
function normalizePath(path) {
  return path.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.').join('/');
}

// Оглавление архива: размер каждого файла (приёмник выделяет буфер один раз) и
// точное имя элемента — по нему второй проход достаёт вложенный архив.
// 7-Zip читает оглавление без распаковки, поэтому это быстро даже для RAR.
async function listEntries(blob, name) {
  const entries = new Map();
  let path = null;
  const module = await newSevenZip((line) => {
    const at = line.indexOf('Path = ');
    if (at !== -1) path = line.slice(at + 7);
    else if (line.startsWith('Size = ') && path !== null) {
      entries.set(normalizePath(path), { size: Number(line.slice(7)), itemPath: path });
      path = null;
    }
  });
  mountArchive(module, blob, name);
  try {
    module.callMain(['l', '-slt', '-ba', '-bsp0', `/in/${name}`, '-pvidi-no-password']);
  } catch {
    // без оглавления файлы собираются из кусков, а вложенные архивы держатся в памяти
  }
  return entries;
}

// Перехват записи 7-Zip в /out: данные идут в Sink, а не в файловую систему.
// onFile(entryPath, result) вызывается, когда 7-Zip закрывает файл.
// keepArchives(entryPath) решает, держать ли вложенный архив в памяти.
function interceptOutput(module, entries, keepArchives, onFile) {
  const FS = module.FS;
  FS.mkdir('/out');
  const original = { open: FS.open, write: FS.write, llseek: FS.llseek, ftruncate: FS.ftruncate, close: FS.close };

  FS.open = (path, flags, mode) => {
    const stream = original.open.call(FS, path, flags, mode);
    const writable = typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & 3) !== 0;
    if (writable && stream.path?.startsWith('/out/') && FS.isFile(stream.node.mode)) {
      const entryPath = normalizePath(stream.path.slice('/out/'.length));
      stream.vidiSink = new Sink(entries.get(entryPath)?.size, keepArchives(entryPath));
    }
    return stream;
  };
  FS.write = (stream, buffer, offset, length, position, canOwn) => {
    const sink = stream.vidiSink;
    if (!sink) return original.write.call(FS, stream, buffer, offset, length, position, canOwn);
    const at = typeof position === 'number' ? position : stream.position;
    if (at !== sink.size) throw new FS.ErrnoError(29); // ESPIPE: пишем только подряд
    // buffer — это куча WASM, которую 7-Zip переиспользует: Sink копирует данные.
    sink.write(buffer.subarray(offset, offset + length));
    if (typeof position !== 'number') stream.position += length;
    return length;
  };
  FS.llseek = (stream, offset, whence) => {
    const sink = stream.vidiSink;
    if (!sink) return original.llseek.call(FS, stream, offset, whence);
    const base = whence === 1 ? stream.position : whence === 2 ? sink.size : 0;
    stream.position = base + offset;
    return stream.position;
  };
  FS.ftruncate = (fd, length) => {
    const stream = FS.getStream(fd);
    if (stream?.vidiSink) {
      if (length > stream.vidiSink.expected && stream.vidiSink.kind === null) stream.vidiSink.expected = length;
      return;
    }
    return original.ftruncate.call(FS, fd, length);
  };
  FS.close = (stream) => {
    const sink = stream.vidiSink;
    const path = stream.path;
    stream.vidiSink = null;
    original.close.call(FS, stream);
    if (sink) onFile(normalizePath(path.slice('/out/'.length)), sink.finish());
  };
}

function runSevenZip(module, args) {
  let code;
  try {
    // Пароль-заглушка: без него 7-Zip ждёт ввода и зависает на зашифрованном архиве.
    code = module.callMain([...args, '-pvidi-no-password', '-bso0', '-bsp0']);
  } catch (e) {
    code = typeof e?.status === 'number' ? e.status : -1;
  }
  stats.sevenZipRuns++;
  stats.wasmHeapMB = Math.max(stats.wasmHeapMB, lastWasmHeapMB());
  if (code !== 0) throw new Error(`7z:${sevenZipError(code)}`);
}

// Два прохода. Первый распаковывает всё, но вложенные архивы только запоминает
// по пути, не держа их в памяти: внутри callMain нельзя дождаться разбора
// вложенного архива, а копить их все до конца — это сотни мегабайт. Второй
// проход достаёт вложенные архивы по одному и сразу разбирает.
async function readWith7z(source, depth, kind) {
  const blob = source instanceof Uint8Array ? new Blob([source]) : source;
  const name = `archive.${kind === 'rar5' ? 'rar' : kind}`;
  let phase = performance.now();
  const entries = await listEntries(blob, name);
  if (depth === 0) stats.entriesTotal = entries.size;
  stats.listMs += performance.now() - phase;
  phase = performance.now();

  // Вложенный архив, которого нет в оглавлении, второй проход не найдёт —
  // такой держим в памяти сразу, как в простом варианте.
  const laterPaths = [];
  const inMemory = [];
  const first = await newSevenZip();
  mountArchive(first, blob, name);
  interceptOutput(first, entries, (path) => !entries.has(path), (path, result) => {
    const inner = account(result);
    if (inner) inMemory.push(inner);
    else if (isArchive(result.kind)) laterPaths.push(path);
    tick();
  });
  runSevenZip(first, ['x', `/in/${name}`, '-o/out', '-y']);
  stats.extractMs += performance.now() - phase;

  for (const inner of inMemory.splice(0)) await readAny(inner, depth + 1);

  for (const path of laterPaths) {
    let inner = null;
    phase = performance.now();
    const module = await newSevenZip();
    mountArchive(module, blob, name);
    interceptOutput(module, entries, () => true, (_, result) => { inner = result.bytes; });
    // -spd: имя — это имя, а не маска; в именах бывают [ ] и *.
    runSevenZip(module, ['x', `/in/${name}`, '-o/out', '-y', '-spd', entries.get(path).itemPath]);
    if (!inner) throw new Error('nested-missing');
    stats.nestedMs += performance.now() - phase;
    await readAny(inner, depth + 1);
  }
}

async function readAny(source, depth) {
  if (depth > MAX_DEPTH) throw new Error('too-deep');
  const head = source instanceof Uint8Array
    ? source.subarray(0, HEAD)
    : new Uint8Array(new FileReaderSync().readAsArrayBuffer(source.slice(0, HEAD)));
  const kind = detect(head);
  if (depth === 0) stats.format = kind;
  if (kind === 'zip') return readZip(source, depth);
  if (kind === 'dicom') {
    account({ kind, size: source.size ?? source.length, bytes: null });
    return;
  }
  if (kind === 'unknown') throw new Error('unknown-format');
  return readWith7z(source, depth, kind);
}

self.onmessage = async ({ data }) => {
  stats = newStats();
  study = newStudy();
  fill = null;
  stats.archiveBytes = data.file.size;
  debugGc = data.debugGc === true;
  readAheadBytes = data.noReadAhead === true ? 0 : 16 * 1048576;
  try {
    if (data.fill) startFill(data.fill);
    await readAny(data.file, 0);
    if (fill) {
      const { data: volume, out, filled, skipped, histogram } = fill;
      const missing = out.d - filled;
      self.postMessage({
        type: 'volume',
        stats: { ...stats, elapsedMs: performance.now() - stats.startedAt },
        volume: { data: volume, ...out, filled, missing, skipped, histogram },
      }, [volume.buffer, histogram.buffer]);
      fill = null;
      return;
    }
    post('done', { study: studySummary() });
  } catch (e) {
    const reason = String(e?.message || e).slice(0, 60);
    post('failed', { reason: /^[\w:.-]+$/.test(reason) ? reason : 'exception' });
  }
};
