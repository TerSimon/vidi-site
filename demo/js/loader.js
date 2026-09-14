// Загрузка объёма: fetch с прогрессом + распаковка gzip в браузере.

export async function fetchManifest(base) {
  const res = await fetch(`${base}ct.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`ct.json: HTTP ${res.status}`);
  return res.json();
}

export async function fetchLevel(base, level, onProgress, signal) {
  const query = level.version ? `?v=${level.version}` : '';
  const res = await fetch(`${base}${level.file}${query}`, { signal });
  if (!res.ok) throw new Error(`${level.file}: HTTP ${res.status}`);

  let bytes;
  if (res.body && res.body.getReader) {
    // Хостинг может отдать файл со сжатием на лету — тогда Content-Length не
    // совпадёт с числом прочитанных байт. Прогресс просто упирается в 100 %.
    const total = level.bytes || Number(res.headers.get('Content-Length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress(Math.min(1, received / total));
    }
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  onProgress(1);

  // Файл — сырой gzip. Если сервер уже распаковал его сам, сигнатуры 1f 8b не будет.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('no-decompression-stream');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const [w, h, d] = level.dims;
  if (bytes.length !== w * h * d) {
    throw new Error(`${level.file}: ожидалось ${w * h * d} байт, получено ${bytes.length}`);
  }
  return bytes;
}
