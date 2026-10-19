// Взгляд внутрь ZIP: есть ли в архиве снимок и чей. Читает оглавление в конце
// архива и начало нескольких файлов — по одному снимку из каждой папки архива;
// весь архив не распаковывается. Так страница отличает CT.zip со снимком от
// CDViewer64.zip с программой просмотра и узнаёт, сколько в папке пациентов.

import { peekBytes } from './dicom-peek.js?v=8';
import { isJunk, archiveByName, skipPeek } from './plan.js?v=8';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY = 32 * 1024 * 1024;   // оглавление больше — не разбираем
const MAX_FOLDERS = 64;                    // папок архива, из которых берём по снимку
const TRIES_PER_FOLDER = 3;                // первые файлы папки бывают не снимками
const MAX_PACKED = 8 * 1024 * 1024;        // сжатый файл больше — не распаковываем
const MAX_READ = 32 * 1024 * 1024;         // всего читаем из одного архива
const HEAD = 1024 * 1024;                  // начала файла хватает на заголовок

/**
 * → { kind: 'zip', infos } — снимки внутри, infos — их заголовки (по одному на папку);
 *   { kind: 'other' } — снимков нет (программа, документы);
 *   { kind: 'opaque' } — не понять: не ZIP, шифр, чужое сжатие, архив в архиве.
 */
export async function peekZip(file) {
  let entries;
  try {
    entries = await directory(file);
  } catch {
    entries = null;
  }
  if (!entries) return { kind: 'opaque' };

  const folders = new Map();
  let nested = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/') || isJunk(entry.name)) continue;
    const name = entry.name.split('/').pop();
    if (archiveByName(name)) {
      nested += 1;
      continue;
    }
    if (skipPeek(name)) continue;
    const folder = entry.name.slice(0, entry.name.length - name.length);
    if (!folders.has(folder)) {
      if (folders.size >= MAX_FOLDERS) continue;
      folders.set(folder, []);
    }
    const list = folders.get(folder);
    if (list.length < TRIES_PER_FOLDER) list.push(entry);
  }

  const infos = [];
  let unreadable = 0;
  let budget = MAX_READ;
  for (const list of folders.values()) {
    for (const entry of list) {
      if (budget <= 0) {
        unreadable += 1;
        break;
      }
      budget -= Math.min(entry.packed, HEAD);
      const head = await headOf(file, entry).catch(() => undefined);
      if (head === undefined) {
        unreadable += 1;
        continue;
      }
      const info = peekBytes(head);
      if (info) {
        infos.push(info);
        break;
      }
    }
  }
  if (infos.length) return { kind: 'zip', infos };
  return nested || unreadable ? { kind: 'opaque' } : { kind: 'other' };
}

/** Оглавление: [{ name, flags, method, packed, size, local }] или null. */
async function directory(file) {
  if (file.size < 22) return null;
  const tailStart = Math.max(0, file.size - (22 + MAX_COMMENT + 20));
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD && i + 22 + tail.getUint16(i + 20, true) <= tail.byteLength) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  let count = tail.getUint16(end + 10, true);
  let size = tail.getUint32(end + 12, true);
  let offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: настоящие числа — в отдельной записи, на неё указывает «локатор».
    if (end < 20 || tail.getUint32(end - 20, true) !== LOCATOR64) return null;
    const at = Number(tail.getBigUint64(end - 20 + 8, true));
    const record = new DataView(await file.slice(at, at + 56).arrayBuffer());
    if (record.byteLength < 56 || record.getUint32(0, true) !== EOCD64) return null;
    count = Number(record.getBigUint64(32, true));
    size = Number(record.getBigUint64(40, true));
    offset = Number(record.getBigUint64(48, true));
  }
  if (size > MAX_DIRECTORY || offset + size > file.size) return null;

  const view = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const names = new TextDecoder();
  const entries = [];
  let off = 0;
  while (entries.length < count && off + 46 <= view.byteLength) {
    if (view.getUint32(off, true) !== CENTRAL) return null;
    const nameLength = view.getUint16(off + 28, true);
    const extraLength = view.getUint16(off + 30, true);
    const commentLength = view.getUint16(off + 32, true);
    const entry = {
      flags: view.getUint16(off + 8, true),
      method: view.getUint16(off + 10, true),
      packed: view.getUint32(off + 20, true),
      size: view.getUint32(off + 24, true),
      local: view.getUint32(off + 42, true),
      name: names.decode(new Uint8Array(view.buffer, off + 46, nameLength)).replace(/\\/g, '/'),
    };
    // ZIP64: большие размеры и смещение — в дополнительном поле 0x0001, по порядку.
    let x = off + 46 + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = view.getUint16(x, true);
      const length = view.getUint16(x + 2, true);
      if (id === 1) {
        let p = x + 4;
        for (const key of ['size', 'packed', 'local']) {
          if (entry[key] === 0xffffffff && p + 8 <= x + 4 + length) {
            entry[key] = Number(view.getBigUint64(p, true));
            p += 8;
          }
        }
      }
      x += 4 + length;
    }
    entries.push(entry);
    off = extraEnd + commentLength;
  }
  return entries;
}

/** Начало файла внутри архива или undefined, если его не прочесть. */
async function headOf(file, entry) {
  if (entry.flags & 1) return undefined;                                // шифр
  if (entry.method !== 0 && (entry.method !== 8 || entry.packed > MAX_PACKED)) return undefined;
  const local = new DataView(await file.slice(entry.local, entry.local + 30).arrayBuffer());
  if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL) return undefined;
  const start = entry.local + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  if (entry.method === 0) return file.slice(start, start + Math.min(entry.packed, HEAD)).arrayBuffer();
  return inflateHead(file.slice(start, start + entry.packed), HEAD);
}

/**
 * Распаковка начала файла: сжатые байты целиком (их немного), а распакованное —
 * только до limit, дальше поток бросаем. Обрезанный поток не нужен: ошибка «нет
 * конца» стирает из потока уже распакованное.
 */
async function inflateHead(packed, limit) {
  const reader = packed.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(limit);
  let got = 0;
  try {
    while (got < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, limit - got);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } catch {
    if (!got) return undefined;
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.slice(0, got).buffer;
}
