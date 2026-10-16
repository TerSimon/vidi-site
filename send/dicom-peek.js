// Быстрый взгляд на файл: снимок ли это и чей. Читает только начало файла —
// заголовок DICOM, — чтобы показать отправителю «Иванов И. И., КТ, 12.10.2026»
// до отправки и не тащить в Vidi программу-просмотрщик с диска.
//
// Проходит неявный и явный VR, последовательности неизвестной длины (в том
// числе UN — внутри у неё неявный VR по стандарту) и значения во вложенных
// item не путает с верхним уровнем.

// Заголовок обычно занимает единицы килобайт; длинные последовательности перед
// именем пациента бывают — тогда второй заход читает мегабайт.
const HEAD_BYTES = 64 * 1024;
const LONG_HEAD_BYTES = 1024 * 1024;
const UNDEFINED = 0xffffffff;
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_BE = '1.2.840.10008.1.2.2';
const DEFLATED = '1.2.840.10008.1.2.1.99';

const WANTED = new Map([
  ['0008,0005', 'charset'],
  ['0008,0020', 'date'],
  ['0008,0060', 'modality'],
  ['0008,1030', 'description'],
  ['0010,0010', 'patient'],
  ['0020,000D', 'study'],
]);

const ARCHIVE_EXT = /\.(zip|rar|7z|tar|tgz|gz)$/i;

/** Архив по имени или по первым байтам. */
export async function isArchive(file) {
  if (ARCHIVE_EXT.test(file.name)) return true;
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) // ZIP
    || (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) // Rar!
    || (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) // 7z
    || (b[0] === 0x1f && b[1] === 0x8b); // gzip
}

/**
 * Заголовок снимка — или null, если это не DICOM.
 * → { patient, date, modality, description, study }
 */
export async function peek(file) {
  const info = await peekHead(file, HEAD_BYTES);
  if (info && !info.patient && !info.study && file.size > HEAD_BYTES) {
    return (await peekHead(file, LONG_HEAD_BYTES)) ?? info;
  }
  return info;
}

async function peekHead(file, bytes) {
  const buf = await file.slice(0, bytes).arrayBuffer();
  const view = new DataView(buf);
  const raw = {};
  let off;
  let explicit = true;
  let little = true;

  const magic = buf.byteLength >= 132
    && view.getUint32(128, false) === 0x4449434d; // "DICM"
  if (magic) {
    off = 132;
    // Группа 0002 — всегда явный VR, little-endian.
    let ts = '';
    while (off + 8 <= buf.byteLength && view.getUint16(off, true) === 0x0002) {
      const el = readElement(view, off, true, true);
      if (!el) return null;
      if (el.tag === '0002,0010') ts = text(new Uint8Array(buf, el.value, el.length)).replace(/\0/g, '').trim();
      off = el.value + el.length;
    }
    if (ts === DEFLATED) return { patient: '', date: '', modality: '', description: '', study: '' };
    explicit = ts !== IMPLICIT_LE;
    little = ts !== EXPLICIT_BE;
  } else {
    // Без преамбулы: набор данных с самого начала. Первая группа — 0008 или 0002.
    if (buf.byteLength < 8) return null;
    const group = view.getUint16(0, true);
    if (group !== 0x0008 && group !== 0x0002) return null;
    explicit = isVR(view, 4);
    off = 0;
  }

  walk(view, off, buf.byteLength, explicit, little, 0, raw);
  if (!magic && !raw['0008,0020'] && !raw['0010,0010'] && !raw['0020,000D']) return null;

  const charset = raw['0008,0005'] ? text(raw['0008,0005']) : '';
  const field = (tag) => (raw[tag] ? decode(raw[tag], charset) : '');
  return {
    patient: personName(field('0010,0010')),
    date: dicomDate(field('0008,0020')),
    modality: field('0008,0060').trim(),
    description: field('0008,1030').trim(),
    study: field('0020,000D').replace(/\0/g, '').trim(),
  };
}

function isVR(view, off) {
  if (off + 2 > view.byteLength) return false;
  const a = view.getUint8(off);
  const b = view.getUint8(off + 1);
  return a >= 0x41 && a <= 0x5a && b >= 0x41 && b <= 0x5a;
}

function hex(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function readElement(view, off, explicit, little) {
  if (off + 8 > view.byteLength) return null;
  const group = view.getUint16(off, little);
  const element = view.getUint16(off + 2, little);
  const tag = `${hex(group)},${hex(element)}`;
  if (group === 0xfffe) {
    return { tag, group, element, vr: '', length: view.getUint32(off + 4, little), value: off + 8 };
  }
  if (explicit && isVR(view, off + 4)) {
    const vr = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5));
    if (LONG_VR.has(vr)) {
      if (off + 12 > view.byteLength) return null;
      return { tag, group, element, vr, length: view.getUint32(off + 8, little), value: off + 12 };
    }
    return { tag, group, element, vr, length: view.getUint16(off + 6, little), value: off + 8 };
  }
  return { tag, group, element, vr: '', length: view.getUint32(off + 4, little), value: off + 8 };
}

/**
 * Обход элементов до конца буфера, конца item (→ после разделителя) или пикселей.
 * Значения нужных тегов берутся только с верхнего уровня (depth 0).
 */
function walk(view, off, end, explicit, little, depth, out) {
  while (off + 8 <= end) {
    const el = readElement(view, off, explicit, little);
    if (!el) return end;
    if (el.group === 0xfffe) {
      // Конец item или последовательности — вернуть место сразу за разделителем.
      return el.value;
    }
    if (depth === 0 && el.group === 0x7fe0 && el.element === 0x0010) return end;
    if (el.length === UNDEFINED) {
      // Последовательность неизвестной длины. UN внутри — неявный VR.
      const inner = el.vr === 'UN' ? false : explicit;
      const next = skipSequence(view, el.value, end, inner, little, depth + 1);
      if (next === null) return end;
      off = next;
      continue;
    }
    if (depth === 0 && WANTED.has(el.tag) && !(el.tag in out) && el.value + el.length <= end) {
      out[el.tag] = new Uint8Array(view.buffer, el.value, el.length);
    }
    off = el.value + el.length;
  }
  return end;
}

/** Пропуск последовательности неизвестной длины → место после её разделителя. */
function skipSequence(view, off, end, explicit, little, depth) {
  while (off + 8 <= end) {
    const group = view.getUint16(off, little);
    const element = view.getUint16(off + 2, little);
    const length = view.getUint32(off + 4, little);
    if (group !== 0xfffe) return null;
    if (element === 0xe0dd) return off + 8;
    if (element !== 0xe000) return null;
    if (length === UNDEFINED) {
      off = walk(view, off + 8, end, explicit, little, depth, {});
    } else {
      off = off + 8 + length;
    }
  }
  return null;
}

function text(bytes) {
  return new TextDecoder('latin1').decode(bytes);
}

const CHARSETS = {
  'ISO_IR 192': 'utf-8',
  'ISO_IR 144': 'iso-8859-5',
  'ISO 2022 IR 144': 'iso-8859-5',
  'ISO_IR 100': 'windows-1252',
  'ISO 2022 IR 100': 'windows-1252',
  'ISO_IR 6': 'utf-8',
};

/** Объявленная кодировка; без неё — UTF-8, а если байты не UTF-8 — CP1251. */
export function decode(bytes, charset) {
  const declared = charset.split('\\').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  const label = CHARSETS[declared];
  if (label) return new TextDecoder(label).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** «Иванов^Иван^Иванович» → «Иванов Иван Иванович». */
export function personName(value) {
  return value.split('=')[0].replace(/\0/g, '').split('^').map((s) => s.trim())
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** «20261012» → «12.10.2026». */
export function dicomDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
