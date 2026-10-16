// Упаковка и шифрование снимка для приёма в Vidi. Работает в браузере и в Node
// (WebCrypto, потоки, CompressionStream — одни и те же).
//
// Формат (его же читает Vidi на Mac):
//   ключ     ECDH P-256 (одноразовая пара отправителя × открытый ключ Mac)
//            → HKDF-SHA256(salt 32 байта, info "vidi-inbox v1") → AES-256-GCM;
//   описание JSON, nonce FF FF FF FF + 8 нулей, AAD "vidi-inbox v1|meta";
//   поток    "VIDIBOX1", затем файлы: u16 длина пути, путь UTF-8, u64 размер,
//            байты; в конце u16 0. Поток сжат deflate-raw (meta.compression);
//   части    по `size` байт, nonce 4 нуля + u64 номер части,
//            AAD "vidi-inbox v1|<номер>|<1 — последняя, иначе 0>".
// Номер и признак последней части в AAD: часть не переставить и не отрезать.
// Все числа — big-endian.

export const INFO = 'vidi-inbox v1';
const MAGIC = 'VIDIBOX1';

const utf8 = (text) => new TextEncoder().encode(text);

/** Ключ шифрования для открытого ключа Mac (несжатая точка P-256, 65 байт). */
export async function makeEnvelope(recipientRaw, salt = crypto.getRandomValues(new Uint8Array(32))) {
  const subtle = crypto.subtle;
  const recipient = await subtle.importKey('raw', recipientRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, pair.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(INFO) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const senderKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { key, senderKey, salt };
}

export function chunkNonce(index) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));
  return iv;
}

export function chunkAad(index, last) {
  return utf8(`${INFO}|${index}|${last ? 1 : 0}`);
}

export const META_NONCE = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
export const META_AAD = utf8(`${INFO}|meta`);

export async function sealMeta(key, meta) {
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: META_NONCE, additionalData: META_AAD }, key, utf8(JSON.stringify(meta)));
  return new Uint8Array(sealed);
}

export async function sealChunk(key, index, last, plain) {
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: chunkNonce(index), additionalData: chunkAad(index, last) }, key, plain);
  return new Uint8Array(sealed);
}

/**
 * Поток упаковки. entries — [{ path, file }], file — Blob/File.
 * onRead(n) — прочитано ещё n байт самих файлов (для полосы отправки).
 */
export function containerStream(entries, onRead = () => {}) {
  async function* parts() {
    yield utf8(MAGIC);
    for (const { path, file } of entries) {
      const name = utf8(path);
      const head = new Uint8Array(2 + name.length + 8);
      const view = new DataView(head.buffer);
      view.setUint16(0, name.length);
      head.set(name, 2);
      view.setBigUint64(2 + name.length, BigInt(file.size));
      yield head;
      const reader = file.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        onRead(value.length);
        yield value;
      }
    }
    yield new Uint8Array(2);
  }
  const it = parts();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

/** Сжатие, если браузер умеет; иначе поток как есть. → { stream, compression } */
export function compress(stream) {
  if (typeof CompressionStream === 'undefined') return { stream, compression: 'none' };
  return { stream: stream.pipeThrough(new CompressionStream('deflate-raw')), compression: 'deflate-raw' };
}

/**
 * Режет поток на части ровно по `size` байт; последняя — остаток (у пустого
 * потока — одна пустая часть). Полную часть отдаёт, только когда за ней точно
 * есть данные: признак «последняя» нужен уже при шифровании.
 */
export async function* chunks(stream, size) {
  const reader = stream.getReader();
  let pieces = [];
  let have = 0;
  let index = 0;

  const take = (n) => {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = pieces[0];
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        pieces.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        pieces[0] = head.subarray(need);
        filled += need;
      }
    }
    have -= n;
    return out;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value.length) continue;
    pieces.push(value);
    have += value.length;
    while (have > size) yield { index: index++, last: false, bytes: take(size) };
  }
  yield { index: index++, last: true, bytes: take(have) };
}

export const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
