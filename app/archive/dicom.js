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
// SV и UV — 64-битные целые из поздних редакций стандарта: без них короткая
// длина прочиталась бы из середины настоящей, и разбор ушёл бы вразнос.
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OL', 'OD', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR', 'SV', 'UV']);

const UNDEFINED = 0xffffffff;
const TAG_ITEM = 0xfffee000;
const TAG_ITEM_END = 0xfffee00d;
const TAG_SEQ_END = 0xfffee0dd;
const TAG_PIXEL_DATA = 0x7fe00010;

// Enhanced CT: один файл — все срезы. Геометрия у такого файла лежит не в
// обычных полях, а в группах: общей для всех кадров и своей у каждого кадра.
const TAG_SHARED_FG = 0x52009229;
const TAG_PER_FRAME_FG = 0x52009230;
const TAG_PIXEL_MEASURES = 0x00289110;
const TAG_PLANE_POSITION = 0x00209113;
const TAG_PLANE_ORIENTATION = 0x00209116;
const TAG_VALUE_TRANSFORM = 0x00289145;

// Оглавление архива (DICOMDIR). Это полноценный файл DICOM с той же меткой в
// начале, но снимка в нём нет — только список того, что лежит рядом. Принимать
// его за испорченный срез нельзя: врач получит тревогу на ровном месте.
const SOP_DICOMDIR = '1.2.840.10008.1.3.10';

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
  text(n, charset) {
    // DICOM разрешает разные кодировки; кириллица в экспортах клиник обычно
    // приходит в CP1251, а UTF-8 встречается у современных аппаратов.
    const raw = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return decodeText(raw, charset);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');
const cp1251 = new TextDecoder('windows-1251');
const CYRILLIC = /[Ѐ-ӿ]/;

/**
 * (0008,0005) Specific Character Set → метка для TextDecoder. Те же кодировки,
 * что понимает приложение на Mac (`encodingFromCharSet`). Латиница — null:
 * она ничего не добавляет к угадыванию ниже.
 */
function charsetLabel(raw) {
  const key = raw.replace(/\\/g, ' ').toUpperCase().trim();
  if (key.includes('IR 192')) return 'utf-8';
  if (key.includes('IR 144')) return 'iso-8859-5';
  if (key.includes('GB18030')) return 'gb18030';
  if (key.includes('IR 101')) return 'iso-8859-2';
  if (key.includes('IR 138')) return 'iso-8859-8';
  if (key.includes('IR 148')) return 'iso-8859-9';
  return null;
}

const decoders = new Map();

function decodeWith(label, raw) {
  if (!decoders.has(label)) {
    let d = null;
    try { d = new TextDecoder(label); } catch (e) { d = null; }
    decoders.set(label, d);
  }
  const d = decoders.get(label);
  return d ? d.decode(raw) : null;
}

/**
 * Текст из заголовка. Порядок — как на Mac (`decodeString`), потому что врач
 * должен увидеть одно и то же имя в обоих местах:
 *  1. объявленная кодировка — только если дала кириллицу: русские станции
 *     часто пишут в поле одно, а байты кладут в CP1251;
 *  2. правильный UTF-8;
 *  3. CP1251, затем CP866 — если дали кириллицу;
 *  4. объявленная кодировка или латиница.
 * От Mac одно отличие: правильный UTF-8 принимается и без кириллицы, иначе
 * «José» в UTF-8 превращался бы в «JosГ©».
 */
function decodeText(raw, charset) {
  let text;
  if (!raw.some((b) => b >= 0x80)) {
    text = latin1.decode(raw);
  } else {
    text = null;
    if (charset) {
      const declared = decodeWith(charset, raw);
      if (declared !== null && CYRILLIC.test(declared)) text = declared;
    }
    if (text === null) {
      try { text = utf8.decode(raw); } catch (e) { text = null; }
    }
    if (text === null) {
      const w = cp1251.decode(raw);
      if (CYRILLIC.test(w)) text = w;
    }
    if (text === null) {
      // Через decodeWith: редкую кодировку браузер вправе не знать, и падать
      // из-за неё весь разбор не должен.
      const d = decodeWith('ibm866', raw);
      if (d !== null && CYRILLIC.test(d)) text = d;
    }
    if (text === null) text = (charset && decodeWith(charset, raw)) ?? latin1.decode(raw);
  }
  return text.replace(/\0+$/, '').trim();
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
 * В каком режиме читать содержимое элемента неизвестной длины.
 *
 * Обычно — в том же, что и весь файл. Исключение — UN: так пишет последовательность
 * PACS, которая не знает частного тега аппарата, и её содержимое по стандарту
 * (PS3.5, 6.2.2) всегда в неявном VR с прямым порядком байт. Прочитанное как
 * явное, оно сбивает разбор, и он обрывается раньше размеров снимка.
 */
function innerMode(el, explicit, le) {
  return el.vr === 'UN' ? { explicit: false, le: true } : { explicit, le };
}

/**
 * Пропуск элемента неизвестной длины: спускаемся по элементам до разделителя.
 * Именно здесь ломались чужие разборы — без спуска внутрь чтение уходит за
 * конец файла, и снимок выглядит пустым, а не испорченным.
 *
 * Спуск рекурсивный, чтобы у вложенного UN был свой режим чтения. Глубина
 * ограничена: испорченный файл не должен уводить разбор в бесконечный спуск.
 */
function skipUndefined(r, explicit, le, depth = 0) {
  if (depth > 32) return false;
  while (r.left >= 8) {
    const el = readElement(r, explicit, le);
    if (!el) return false;
    if (el.tag === TAG_SEQ_END || el.tag === TAG_ITEM_END) return true;
    if (el.length === UNDEFINED) {       // item или вложенная SQ
      const mode = innerMode(el, explicit, le);
      if (!skipUndefined(r, mode.explicit, mode.le, depth + 1)) return false;
      continue;
    }
    r.at = el.dataAt + el.length;
    if (r.at > r.bytes.length) return false;
  }
  return false;
}

/**
 * Элементы последовательности: где начинается и кончается каждый item.
 * `next` — куда встать после всей последовательности. null — файл испорчен.
 */
function sequenceItems(bytes, el, explicit, le) {
  const mode = innerMode(el, explicit, le);
  const r = new Reader(bytes);
  r.at = el.dataAt;
  const end = el.length === UNDEFINED ? bytes.length : el.dataAt + el.length;
  if (end > bytes.length) return null;
  const items = [];
  while (end - r.at >= 8) {
    const it = readElement(r, mode.explicit, mode.le);
    if (!it) return null;
    if (it.tag === TAG_SEQ_END) break;
    if (it.tag !== TAG_ITEM) return null;
    if (it.length === UNDEFINED) {
      const start = r.at;
      if (!skipUndefined(r, mode.explicit, mode.le)) return null;
      items.push({ start, end: r.at - 8, ...mode });    // без разделителя item
    } else {
      const itemEnd = it.dataAt + it.length;
      if (itemEnd > end) return null;
      items.push({ start: it.dataAt, end: itemEnd, ...mode });
      r.at = itemEnd;
    }
  }
  return { items, next: el.length === UNDEFINED ? r.at : end };
}

/**
 * Обходит элементы внутри item. `visit(el)` зовётся для каждого; спускаться
 * ли глубже, решает он сам. false — внутри что-то испорчено.
 */
function eachElement(bytes, range, visit) {
  const r = new Reader(bytes);
  r.at = range.start;
  while (range.end - r.at >= 8) {
    const el = readElement(r, range.explicit, range.le);
    if (!el) return false;
    visit(el);
    if (el.length === UNDEFINED) {
      r.at = el.dataAt;
      const mode = innerMode(el, range.explicit, range.le);
      if (!skipUndefined(r, mode.explicit, mode.le)) return false;
    } else {
      r.at = el.dataAt + el.length;
      if (r.at > range.end) return false;
    }
  }
  return true;
}

/** Значение простого элемента строкой. */
function asciiAt(bytes, el) {
  if (el.length === UNDEFINED || el.dataAt + el.length > bytes.length) return '';
  const r = new Reader(bytes);
  r.at = el.dataAt;
  return r.ascii(el.length);
}

/**
 * Одна функциональная группа кадра (или общая для всех): размер точки,
 * положение, направление осей и перевод значений в HU. Берётся первый item
 * каждого макроса — больше одного стандарт там не допускает.
 */
function functionalGroup(bytes, range) {
  const out = {};
  const leaves = (macroEl, read) => {
    const seq = sequenceItems(bytes, macroEl, range.explicit, range.le);
    const first = seq?.items[0];
    if (first) eachElement(bytes, first, read);
  };
  eachElement(bytes, range, (el) => {
    if (el.tag === TAG_PIXEL_MEASURES) {
      leaves(el, (leaf) => {
        if (leaf.tag === tagOf(0x0028, 0x0030)) {
          const v = numbers(asciiAt(bytes, leaf));
          if (v.length === 2) out.pixelSpacing = v;
        } else if (leaf.tag === tagOf(0x0018, 0x0050)) {
          const v = numbers(asciiAt(bytes, leaf));
          if (v.length) out.thickness = v[0];
        }
      });
    } else if (el.tag === TAG_PLANE_POSITION) {
      leaves(el, (leaf) => {
        if (leaf.tag !== tagOf(0x0020, 0x0032)) return;
        const v = numbers(asciiAt(bytes, leaf));
        if (v.length === 3) out.position = v;
      });
    } else if (el.tag === TAG_PLANE_ORIENTATION) {
      leaves(el, (leaf) => {
        if (leaf.tag !== tagOf(0x0020, 0x0037)) return;
        const v = numbers(asciiAt(bytes, leaf));
        if (v.length === 6) out.orientation = v;
      });
    } else if (el.tag === TAG_VALUE_TRANSFORM) {
      leaves(el, (leaf) => {
        if (leaf.tag === tagOf(0x0028, 0x1052)) {
          const v = numbers(asciiAt(bytes, leaf));
          if (v.length) out.intercept = v[0];
        } else if (leaf.tag === tagOf(0x0028, 0x1053)) {
          const v = numbers(asciiAt(bytes, leaf));
          if (v.length) out.slope = v[0];
        }
      });
    }
  });
  return out;
}

/**
 * Переносит геометрию из функциональных групп в обычные поля. Правила — как
 * на Mac: общая группа важнее группы первого кадра; положения по кадрам
 * принимаются, только если они есть у КАЖДОГО кадра. Иначе положений нет
 * вовсе, и миллиметров вдоль объёма не будет — выдумывать их по толщине
 * среза не стали ни здесь, ни на Mac.
 */
function applyFunctionalGroups(out, shared, perFrame) {
  const first = perFrame?.[0] ?? null;
  const spacing = shared?.pixelSpacing ?? first?.pixelSpacing;
  if (spacing) out.pixelSpacing = spacing;
  const thickness = shared?.thickness ?? first?.thickness;
  if (Number.isFinite(thickness)) out.sliceThickness = thickness;

  let orientation = shared?.orientation ?? null;
  if (!orientation && perFrame?.length && perFrame.every((g) => g.orientation)) {
    const o = perFrame[0].orientation;
    const same = perFrame.every((g) => g.orientation.every((x, i) => Math.abs(x - o[i]) < 1e-4));
    if (same) orientation = o;
  }
  if (orientation) out.orientation = orientation;

  const slope = shared?.slope ?? first?.slope;
  const intercept = shared?.intercept ?? first?.intercept;
  if (Number.isFinite(slope) && Number.isFinite(intercept)) {
    out.slope = slope;
    out.intercept = intercept;
  }

  if (perFrame && perFrame.length === out.frames &&
      perFrame.every((g) => Array.isArray(g.position) && g.position.every(Number.isFinite))) {
    out.framePositions = perFrame.map((g) => g.position);
    out.position = out.framePositions[0];
  } else if (!out.position && shared?.position) {
    out.position = shared.position;
  }
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
  let mediaClass = '';
  while (r.left >= 8) {
    const save = r.at;
    const el = readElement(r, true, true);
    if (!el || (el.tag >>> 16) !== 0x0002) { r.at = save; break; }
    if (el.tag === tagOf(0x0002, 0x0002)) mediaClass = r.ascii(el.length).replace(/\0+$/, '').trim();
    if (el.tag === tagOf(0x0002, 0x0010)) transferSyntax = r.ascii(el.length).replace(/\0+$/, '').trim();
    r.at = el.dataAt + el.length;
    if (r.at > bytes.length) return null;
  }

  if (mediaClass === SOP_DICOMDIR) return { directory: true, service: true };

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
    framePositions: null,
  };

  let charset = null;
  let shared = null;
  let perFrame = null;
  // Разбор оборвался на испорченном месте, а не дошёл до конца файла. Файл
  // без снимка, прочитанный целиком, — служебный; оборванный — испорченный.
  let broken = false;
  let imageGroup = false;     // встретилась группа 0028 — описание изображения

  while (r.left >= 8) {
    const el = readElement(r, explicit, le);
    if (!el) { broken = true; break; }

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

    if (el.tag === TAG_SHARED_FG || el.tag === TAG_PER_FRAME_FG) {
      const seq = sequenceItems(bytes, el, explicit, le);
      if (!seq) { broken = true; break; }
      const groups = seq.items.map((item) => functionalGroup(bytes, item));
      if (el.tag === TAG_SHARED_FG) shared = groups[0] ?? null;
      else perFrame = groups;
      r.at = seq.next;
      continue;
    }

    if (el.length === UNDEFINED) {
      r.at = el.dataAt;
      const mode = innerMode(el, explicit, le);
      if (!skipUndefined(r, mode.explicit, mode.le)) { broken = true; break; }
      continue;
    }

    const end = el.dataAt + el.length;
    if (end > bytes.length) { broken = true; break; }
    if ((el.tag >>> 16) === 0x0028) imageGroup = true;

    switch (el.tag) {
      case tagOf(0x0008, 0x0005): charset = charsetLabel(r.ascii(el.length)); break;
      case tagOf(0x0008, 0x0008): out.imageType = r.ascii(el.length).toUpperCase(); break;
      case tagOf(0x0008, 0x0018): out.sopUID = r.ascii(el.length).replace(/\0+$/, '').trim(); break;
      case tagOf(0x0008, 0x0020): out.studyDate = r.ascii(el.length).trim(); break;
      case tagOf(0x0008, 0x103e): out.seriesDescription = r.text(el.length, charset); break;
      case tagOf(0x0010, 0x0010): out.patientName = r.text(el.length, charset); break;
      case tagOf(0x0010, 0x0020): out.patientID = r.text(el.length, charset); break;
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
      case tagOf(0x0028, 0x0008): out.frames = Math.max(1, Math.floor(numbers(r.ascii(el.length))[0] || 1)); break;
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

  if (!out.rows || !out.columns) {
    // DICOM, прочитанный до конца, но без снимка внутри: файл проекта
    // просмотрщика (так кладут их NNT и E-WOO), отчёт, настройки. Это не
    // испорченный срез, и «снимок не прочитался» про него — ложная тревога.
    if (!broken && !out.pixelAt && !imageGroup) return { service: true };
    return null;
  }
  if (shared || perFrame) applyFunctionalGroups(out, shared, perFrame);
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
