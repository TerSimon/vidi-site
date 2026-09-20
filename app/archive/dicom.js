//
//  Чтение заголовка DICOM. Только заголовок: разбор останавливается на первом
//  байте пикселей и запоминает, где они лежат. Пиксели на этом проходе не
//  читаются — 587 МБ снимков в памяти телефон не переживёт, а из заголовка уже
//  известна вся геометрия, по которой потом выделяется объём.
//
//  Главная ловушка формата — последовательности (SQ) с неизвестной длиной.
//  Sirona, SIDEXIS и dcmtk пишут вложенные последовательности именно так, и
//  если не спускаться внутрь элементов правильно, чтение уходит за конец файла
//  и молча возвращает пустоту. На Mac это уже стоило отдельного разбора; здесь
//  то же правило: элемент длиной 0xFFFFFFFF разбирается по элементам, а не
//  пропускается как обычный.
//

const PREAMBLE = 128;

// VR, у которых длина занимает 4 байта, а не 2 (после двух байт заполнения).
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OL', 'OD', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR']);

const UNDEFINED = 0xffffffff;
const TAG_ITEM = 0xfffee000;
const TAG_ITEM_END = 0xfffee00d;
const TAG_SEQ_END = 0xfffee0dd;
const TAG_PIXEL_DATA = 0x7fe00010;

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

/** Сжатие пикселей: в браузере их ещё предстоит раскодировать. */
const UNCOMPRESSED = new Set([TS_IMPLICIT_LE, TS_EXPLICIT_LE, TS_EXPLICIT_BE]);

const tagOf = (group, element) => ((group << 16) | element) >>> 0;

/** Чтение по буферу с оглядкой на конец: за границу не выходим никогда. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  get left() { return this.bytes.length - this.at; }
  u16(le) { const v = this.view.getUint16(this.at, le); this.at += 2; return v; }
  u32(le) { const v = this.view.getUint32(this.at, le); this.at += 4; return v; }
  ascii(n) {
    const s = new TextDecoder('latin1').decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }
  text(n) {
    // DICOM разрешает разные кодировки; кириллица в экспортах клиник обычно
    // приходит в CP1251, а UTF-8 встречается у современных аппаратов.
    const raw = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return decodeText(raw);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1251 = new TextDecoder('windows-1251');

function decodeText(raw) {
  try {
    return utf8.decode(raw).replace(/\0+$/, '').trim();
  } catch (e) {
    // Не UTF-8 — почти всегда CP1251: так пишут русские имена Sidexis и NNT.
    return cp1251.decode(raw).replace(/\0+$/, '').trim();
  }
}

const numbers = (s) => s.split('\\').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));

/** Один элемент заголовка: тег, VR, длина и место данных. */
function readElement(r, explicit, le) {
  if (r.left < 8) return null;
  const group = r.u16(le);
  const element = r.u16(le);
  const tag = tagOf(group, element);

  // Элементы-разделители всегда пишутся без VR, даже в явном режиме.
  if (group === 0xfffe) {
    const length = r.u32(le);
    return { tag, vr: '', length, dataAt: r.at };
  }

  let vr = '';
  let length;
  if (explicit) {
    vr = r.ascii(2);
    if (LONG_VR.has(vr)) {
      r.at += 2; // заполнение
      if (r.left < 4) return null;
      length = r.u32(le);
    } else {
      if (r.left < 2) return null;
      length = r.u16(le);
    }
  } else {
    if (r.left < 4) return null;
    length = r.u32(le);
  }
  return { tag, vr, length, dataAt: r.at };
}

/**
 * Пропуск элемента неизвестной длины: спускаемся по элементам до разделителя.
 * Именно здесь ломались чужие разборы — без спуска внутрь чтение уходит за
 * конец файла, и снимок выглядит пустым, а не испорченным.
 */
function skipUndefined(r, explicit, le) {
  let depth = 1;
  while (depth > 0 && r.left >= 8) {
    const el = readElement(r, explicit, le);
    if (!el) return false;
    if (el.tag === TAG_SEQ_END || el.tag === TAG_ITEM_END) { depth--; continue; }
    if (el.length === UNDEFINED) { depth++; continue; } // item или вложенная SQ
    r.at = el.dataAt + el.length;
    if (r.at > r.bytes.length) return false;
  }
  return depth === 0;
}

/**
 * Разбирает заголовок. Возвращает описание снимка или null, если это не DICOM
 * или заголовок оборван.
 */
export function readDicomHeader(bytes) {
  if (bytes.length < PREAMBLE + 4) return null;
  if (bytes[PREAMBLE] !== 0x44 || bytes[PREAMBLE + 1] !== 0x49 ||
      bytes[PREAMBLE + 2] !== 0x43 || bytes[PREAMBLE + 3] !== 0x4d) return null;

  const r = new Reader(bytes);
  r.at = PREAMBLE + 4;

  // Группа 0002 всегда записана явным VR с прямым порядком байт, независимо
  // от того, в каком синтаксисе лежит всё остальное.
  let transferSyntax = TS_IMPLICIT_LE;
  while (r.left >= 8) {
    const save = r.at;
    const el = readElement(r, true, true);
    if (!el || (el.tag >>> 16) !== 0x0002) { r.at = save; break; }
    if (el.tag === tagOf(0x0002, 0x0010)) transferSyntax = r.ascii(el.length).replace(/\0+$/, '').trim();
    r.at = el.dataAt + el.length;
    if (r.at > bytes.length) return null;
  }

  const explicit = transferSyntax !== TS_IMPLICIT_LE;
  const le = transferSyntax !== TS_EXPLICIT_BE;

  const out = {
    transferSyntax,
    compressed: !UNCOMPRESSED.has(transferSyntax),
    bigEndian: !le,
    patientName: '', patientID: '',
    studyUID: '', seriesUID: '', sopUID: '',
    studyDate: '', seriesDescription: '', imageType: '',
    seriesNumber: null, instanceNumber: null,
    rows: 0, columns: 0, frames: 1,
    bitsAllocated: 0, bitsStored: 0, signed: false,
    samples: 1, monochrome1: false,
    pixelSpacing: null, sliceThickness: null,
    position: null, orientation: null,
    slope: 1, intercept: 0,
    pixelAt: 0, pixelLength: 0,
  };

  while (r.left >= 8) {
    const el = readElement(r, explicit, le);
    if (!el) break;

    if (el.tag === TAG_PIXEL_DATA) {
      if (el.length === UNDEFINED) {
        // Сжатые пиксели лежат фрагментами внутри элемента: где они начинаются,
        // здесь и запоминаем, а разбирать их будет декодер.
        out.pixelAt = el.dataAt;
        out.pixelLength = bytes.length - el.dataAt;
        out.encapsulated = true;
      } else {
        out.pixelAt = el.dataAt;
        out.pixelLength = el.length;
      }
      break;
    }

    if (el.length === UNDEFINED) {
      r.at = el.dataAt;
      if (!skipUndefined(r, explicit, le)) break;
      continue;
    }

    const end = el.dataAt + el.length;
    if (end > bytes.length) break;

    switch (el.tag) {
      case tagOf(0x0008, 0x0008): out.imageType = r.ascii(el.length).toUpperCase(); break;
      case tagOf(0x0008, 0x0018): out.sopUID = r.ascii(el.length).replace(/\0+$/, '').trim(); break;
      case tagOf(0x0008, 0x0020): out.studyDate = r.ascii(el.length).trim(); break;
      case tagOf(0x0008, 0x103e): out.seriesDescription = r.text(el.length); break;
      case tagOf(0x0010, 0x0010): out.patientName = r.text(el.length); break;
      case tagOf(0x0010, 0x0020): out.patientID = r.text(el.length); break;
      case tagOf(0x0018, 0x0050): out.sliceThickness = numbers(r.ascii(el.length))[0] ?? null; break;
      case tagOf(0x0020, 0x000d): out.studyUID = r.ascii(el.length).replace(/\0+$/, '').trim(); break;
      case tagOf(0x0020, 0x000e): out.seriesUID = r.ascii(el.length).replace(/\0+$/, '').trim(); break;
      case tagOf(0x0020, 0x0011): out.seriesNumber = numbers(r.ascii(el.length))[0] ?? null; break;
      case tagOf(0x0020, 0x0013): out.instanceNumber = numbers(r.ascii(el.length))[0] ?? null; break;
      case tagOf(0x0020, 0x0032): {
        const v = numbers(r.ascii(el.length));
        out.position = v.length === 3 ? v : null;
        break;
      }
      case tagOf(0x0020, 0x0037): {
        const v = numbers(r.ascii(el.length));
        out.orientation = v.length === 6 ? v : null;
        break;
      }
      case tagOf(0x0028, 0x0002): out.samples = readUShort(r, el, le) ?? 1; break;
      case tagOf(0x0028, 0x0004): out.monochrome1 = /MONOCHROME1/i.test(r.ascii(el.length)); break;
      case tagOf(0x0028, 0x0008): out.frames = numbers(r.ascii(el.length))[0] || 1; break;
      case tagOf(0x0028, 0x0010): out.rows = readUShort(r, el, le) ?? 0; break;
      case tagOf(0x0028, 0x0011): out.columns = readUShort(r, el, le) ?? 0; break;
      case tagOf(0x0028, 0x0030): {
        const v = numbers(r.ascii(el.length));
        out.pixelSpacing = v.length === 2 ? v : null;
        break;
      }
      case tagOf(0x0028, 0x0100): out.bitsAllocated = readUShort(r, el, le) ?? 0; break;
      case tagOf(0x0028, 0x0101): out.bitsStored = readUShort(r, el, le) ?? 0; break;
      case tagOf(0x0028, 0x0103): out.signed = (readUShort(r, el, le) ?? 0) === 1; break;
      case tagOf(0x0028, 0x1052): out.intercept = numbers(r.ascii(el.length))[0] ?? 0; break;
      case tagOf(0x0028, 0x1053): out.slope = numbers(r.ascii(el.length))[0] ?? 1; break;
      default: break;
    }

    r.at = end;
  }

  if (!out.rows || !out.columns) return null;
  return out;
}

/**
 * Двоичное US/SS. Порядок байт берётся из синтаксиса: в файлах с обратным
 * порядком эти поля раньше читались как прямые, и размер снимка получался
 * бессмысленным.
 */
function readUShort(r, el, le) {
  if (el.length !== 2) return null;
  const v = r.view.getUint16(el.dataAt, le);
  return v;
}
