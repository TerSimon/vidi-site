// Страница отправки КТ: код врача → снимок → шифрование в браузере → загрузка
// частями прямо в хранилище. Сервер Vidi видит только зашифрованное.

import {
  makeEnvelope, sealMeta, sealChunk, containerStream, compress, chunks, toBase64, fromBase64,
} from './pack.js';
import { peek, isArchive } from './dicom-peek.js';
import { CODE_DIGITS, codeValid, codeDigits, formatCode, isOldCode } from './code.js';

const LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const API = LOCAL ? (new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8932')
  : 'https://api.vidiviewer.ru';
const PARALLEL_UPLOADS = 2;
const SCAN_WORKERS = 8;
// Не снимок и Vidi не нужно: программа просмотра с диска, служебное, картинки.
const NOT_DICOM = /\.(exe|dll|inf|ini|ico|bat|cmd|msi|sys|htm|html|js|css|txt|pdf|xml|json|jpg|jpeg|png|bmp|gif|lnk|db|ds_store)$/i;

const $ = (id) => document.getElementById(id);
const ui = {
  code: $('code'), codeStatus: $('code-status'),
  files: $('step-files'), drop: $('drop'), folderInput: $('folder-input'), filesInput: $('files-input'),
  scan: $('scan'), scanCount: $('scan-count'), scanBar: $('scan-bar'),
  found: $('found'), list: $('found-list'), skipped: $('skipped'), foundStatus: $('found-status'),
  send: $('send'), again: $('again'),
  stepSend: $('step-send'), sendTitle: $('send-title'), sendBar: $('send-bar'), sendStatus: $('send-status'),
  sendFail: $('send-fail'), retry: $('retry'),
  done: $('step-done'), more: $('more'),
};

const state = {
  code: null, recipient: null, maxBytes: 0, checkSeq: 0,
  items: [], skipped: { count: 0, bytes: 0 }, busy: false,
};

// ---------- Код врача ----------

const CODE_HINT = 'Код — 6 цифр, его даёт врач.';

function setStatus(el, kind, text) {
  el.className = `status${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
}

function lockFiles(locked) {
  ui.files.setAttribute('aria-disabled', locked ? 'true' : 'false');
}

async function checkCode(code) {
  const seq = ++state.checkSeq;
  setStatus(ui.codeStatus, 'wait', 'Проверяю код…');
  let reply;
  try {
    const r = await fetch(`${API}/inbox/to/${code}`, { cache: 'no-store' });
    reply = { http: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    reply = null;
  }
  if (seq !== state.checkSeq) return;
  if (!reply) {
    setStatus(ui.codeStatus, 'warn', 'Нет связи с сервером. Проверьте интернет.');
  } else if (reply.http === 200 && reply.body.ok) {
    if (!reply.body.storage) {
      setStatus(ui.codeStatus, 'warn', 'Приём снимков временно недоступен. Попробуйте позже.');
      return;
    }
    state.code = code;
    state.recipient = fromBase64(reply.body.public_key);
    state.maxBytes = reply.body.max_bytes;
    setStatus(ui.codeStatus, 'good', 'Код принят');
    lockFiles(false);
    return;
  } else {
    setStatus(ui.codeStatus, 'warn', 'Такого кода нет. Проверьте код у врача.');
  }
  state.code = null;
  lockFiles(true);
}

// Опечатку в коде видно по проверочной цифре — на сервер такой код не уходит.
function readCode() {
  const code = codeDigits(ui.code.value);
  ui.code.value = formatCode(code);
  if (codeValid(code)) {
    if (code !== state.code) checkCode(code);
    return;
  }
  state.checkSeq++;
  state.code = null;
  lockFiles(true);
  if (code.length === CODE_DIGITS) {
    setStatus(ui.codeStatus, 'warn', 'В коде опечатка. Сверьте цифры с врачом.');
  } else {
    setStatus(ui.codeStatus, '', CODE_HINT);
  }
}

ui.code.addEventListener('input', readCode);

// ---------- Выбор снимка ----------

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

// Браузер не уходит со страницы, если файл бросили мимо поля.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

ui.drop.addEventListener('dragenter', (e) => { e.preventDefault(); ui.drop.classList.add('over'); });
ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
ui.drop.addEventListener('dragleave', (e) => {
  if (!ui.drop.contains(e.relatedTarget)) ui.drop.classList.remove('over');
});
ui.drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  ui.drop.classList.remove('over');
  if (!state.code || state.busy) return;
  // Список берётся сразу: после события браузер его отбирает.
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...e.dataTransfer.files];
  beginScan();
  const list = [];
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, '', list);
  } else {
    for (const file of plain) list.push({ path: file.name, file });
  }
  scan(list);
});

ui.drop.querySelector('#pick-folder').addEventListener('click', () => ui.folderInput.click());
ui.drop.querySelector('#pick-files').addEventListener('click', () => ui.filesInput.click());
for (const input of [ui.folderInput, ui.filesInput]) {
  input.addEventListener('change', () => {
    const list = [...input.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    input.value = '';
    if (list.length) scan(list);
  });
}

// ---------- Разбор: что нашлось ----------

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} ГБ`
  : `${Math.max(1, Math.round(bytes / 1e6))} МБ`).replace('.', ',');

const filesWord = (n) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} файл`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} файла`;
  return `${n} файлов`;
};

async function classify(entry) {
  const name = entry.path.split('/').pop();
  if (/^DICOMDIR$/i.test(name) || NOT_DICOM.test(name) || name.startsWith('.')) return { kind: 'skip' };
  if (await isArchive(entry.file)) return { kind: 'archive' };
  const info = await peek(entry.file);
  return info ? { kind: 'dicom', info } : { kind: 'skip' };
}

/** Обход большой папки занимает секунды — строка «Читаю файлы…» видна сразу. */
function beginScan() {
  state.busy = true;
  ui.drop.hidden = true;
  ui.found.hidden = true;
  ui.scan.hidden = false;
  ui.scanCount.textContent = '';
  ui.scanBar.style.width = '0%';
}

async function scan(list) {
  beginScan();
  const groups = new Map();
  const archives = [];
  const skipped = { count: 0, bytes: 0 };
  let done = 0;
  const queue = list.slice();
  const tick = () => {
    ui.scanCount.textContent = `${done} из ${list.length}`;
    ui.scanBar.style.width = `${(100 * done) / Math.max(1, list.length)}%`;
  };
  tick();

  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      let result;
      try {
        result = await classify(entry);
      } catch {
        result = { kind: 'skip' };
      }
      if (result.kind === 'archive') {
        archives.push({ kind: 'archive', title: entry.path.split('/').pop(), entries: [entry], bytes: entry.file.size });
      } else if (result.kind === 'dicom') {
        const { info } = result;
        // Исследование и пациент: номер исследования бывает одинаковым у разных
        // людей (так пишут некоторые аппараты), а смешивать пациентов нельзя.
        const key = `${info.study}|${info.patient}|${info.study ? '' : info.date}`;
        if (!groups.has(key)) groups.set(key, { kind: 'study', info, entries: [], bytes: 0 });
        const g = groups.get(key);
        g.entries.push(entry);
        g.bytes += entry.file.size;
      } else {
        skipped.count += 1;
        skipped.bytes += entry.file.size;
      }
      done += 1;
      if (done % 25 === 0) tick();
    }
  }
  await Promise.all(Array.from({ length: SCAN_WORKERS }, worker));
  tick();

  state.items = [...groups.values(), ...archives];
  state.skipped = skipped;
  state.busy = false;
  showFound();
}

function itemTitle(item) {
  if (item.kind === 'archive') return item.title;
  return item.info.patient || 'Пациент без имени';
}

function itemInfo(item) {
  if (item.kind === 'archive') return `Архив · ${mb(item.bytes)}`;
  const { modality, date } = item.info;
  const parts = [modality === 'CT' ? 'КТ' : modality, date, filesWord(item.entries.length), mb(item.bytes)];
  return parts.filter(Boolean).join(' · ');
}

function showFound() {
  ui.scan.hidden = true;
  ui.list.textContent = '';
  // Один снимок — отмечен сразу. Несколько — отправитель выбирает сам:
  // в общей папке клиники лежат и чужие пациенты.
  const single = state.items.length === 1;
  state.items.forEach((item) => {
    item.on = single;
    const li = document.createElement('li');
    li.className = `found-item${item.on ? ' on' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.on;
    box.setAttribute('aria-label', itemTitle(item));
    const what = document.createElement('div');
    what.className = 'what';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = itemTitle(item);
    const info = document.createElement('div');
    info.className = 'info';
    info.textContent = itemInfo(item);
    what.append(who, info);
    li.append(box, what);
    const toggle = (on) => {
      item.on = on;
      box.checked = on;
      li.classList.toggle('on', on);
      updateSend();
    };
    box.addEventListener('change', () => toggle(box.checked));
    li.addEventListener('click', (e) => { if (e.target !== box) toggle(!item.on); });
    ui.list.append(li);
  });

  if (state.skipped.count) {
    ui.skipped.hidden = false;
    ui.skipped.textContent = `Не отправляются: ${filesWord(state.skipped.count)} — программа просмотра и служебные (${mb(state.skipped.bytes)}).`;
  } else {
    ui.skipped.hidden = true;
  }
  ui.found.hidden = false;
  updateSend();
}

function selected() {
  return state.items.filter((i) => i.on);
}

function updateSend() {
  const items = selected();
  const bytes = items.reduce((s, i) => s + i.bytes, 0);
  if (!state.items.length) {
    setStatus(ui.foundStatus, 'warn', 'Снимков DICOM и архивов не нашлось. Выберите папку со снимком.');
  } else if (!items.length) {
    setStatus(ui.foundStatus, '', state.items.length > 1 ? 'Отметьте, что отправить.' : '');
  } else if (state.maxBytes && bytes > state.maxBytes) {
    setStatus(ui.foundStatus, 'warn', `Больше ${mb(state.maxBytes)} за раз не отправить. Отметьте меньше.`);
  } else {
    setStatus(ui.foundStatus, '', `К отправке: ${mb(bytes)}`);
  }
  ui.send.disabled = !items.length || (state.maxBytes && bytes > state.maxBytes);
}

ui.again.addEventListener('click', () => {
  ui.found.hidden = true;
  ui.drop.hidden = false;
  state.items = [];
});

// ---------- Отправка ----------

class SendError extends Error {}

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new SendError('network');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new SendError(data.status || `http_${r.status}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadPart(item, token, index, data) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { url } = await api('/inbox/part', { item, token, index, size: data.length });
      let put;
      try {
        put = await fetch(url, { method: 'PUT', body: data });
      } catch {
        throw new SendError('network');
      }
      if (!put.ok) throw new SendError(`storage_${put.status}`);
      return;
    } catch (e) {
      if (attempt >= 4 || e.message === 'denied') throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const MESSAGES = {
  not_found: 'Код больше не работает. Попросите у врача новый.',
  inbox_full: 'У врача много непринятых снимков. Попросите его открыть Vidi и отправьте снова.',
  storage_off: 'Приём снимков временно недоступен. Попробуйте позже.',
  too_big: 'Снимок слишком большой. Отправьте его частями.',
  denied: 'Отправка прервалась. Отправьте ещё раз.',
};

async function send() {
  const items = selected();
  const entries = items.flatMap((i) => i.entries);
  const total = entries.reduce((s, e) => s + e.file.size, 0);
  state.busy = true;
  ui.files.hidden = true;
  ui.stepSend.hidden = false;
  ui.sendFail.hidden = true;
  ui.sendBar.style.width = '0%';
  ui.sendTitle.textContent = 'Шифрую и отправляю…';
  setStatus(ui.sendStatus, '', 'Не закрывайте страницу до конца отправки.');
  const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', guard);
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* не важно */ }

  try {
    const envelope = await makeEnvelope(state.recipient);
    let read = 0;
    const { stream, compression } = compress(containerStream(entries, (n) => {
      read += n;
      const pct = Math.min(99, Math.floor((100 * read) / Math.max(1, total)));
      ui.sendBar.style.width = `${pct}%`;
      ui.sendTitle.textContent = `Шифрую и отправляю… ${pct}%`;
    }));
    const meta = {
      v: 1,
      compression,
      studies: items.filter((i) => i.kind === 'study').map((i) => ({
        patient: i.info.patient, date: i.info.date, modality: i.info.modality,
        description: i.info.description, files: i.entries.length, bytes: i.bytes,
      })),
      archives: items.filter((i) => i.kind === 'archive').map((i) => ({ name: i.title, bytes: i.bytes })),
      files: entries.length,
      bytes: total,
      sent_at: new Date().toISOString(),
    };
    const start = await api('/inbox/upload', {
      code: state.code,
      sender_key: toBase64(envelope.senderKey),
      salt: toBase64(envelope.salt),
      meta: toBase64(await sealMeta(envelope.key, meta)),
    });

    const inflight = new Set();
    let failure = null;
    let parts = 0;
    for await (const part of chunks(stream, start.chunk_bytes)) {
      if (failure) throw failure;
      if (part.index >= start.max_parts) throw new SendError('too_big');
      const sealed = await sealChunk(envelope.key, part.index, part.last, part.bytes);
      const job = uploadPart(start.item, start.token, part.index, sealed)
        .catch((e) => { failure = failure || e; })
        .finally(() => inflight.delete(job));
      inflight.add(job);
      parts = part.index + 1;
      while (inflight.size >= PARALLEL_UPLOADS && !failure) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (failure) throw failure;
    await api('/inbox/finish', { item: start.item, token: start.token, parts });

    ui.sendBar.style.width = '100%';
    ui.stepSend.hidden = true;
    ui.done.hidden = false;
  } catch (e) {
    const key = e instanceof SendError ? e.message : 'network';
    ui.sendTitle.textContent = 'Не удалось отправить';
    setStatus(ui.sendStatus, 'warn', MESSAGES[key] || 'Связь прервалась. Проверьте интернет и отправьте ещё раз.');
    ui.sendFail.hidden = false;
  } finally {
    state.busy = false;
    window.removeEventListener('beforeunload', guard);
    wake?.release().catch(() => {});
  }
}

ui.send.addEventListener('click', () => { if (!state.busy) send(); });
ui.retry.addEventListener('click', () => { if (!state.busy) send(); });
ui.more.addEventListener('click', () => {
  ui.done.hidden = true;
  ui.files.hidden = false;
  ui.found.hidden = true;
  ui.drop.hidden = false;
  state.items = [];
});

// ---------- Начало: код из ссылки ----------

let fromLink = location.hash.slice(1);
try { fromLink = decodeURIComponent(fromLink); } catch { /* ссылку исказили — берём как есть */ }
if (isOldCode(fromLink)) {
  // Ссылка из Vidi до этапа 6: буквенный код сервер больше не принимает.
  setStatus(ui.codeStatus, 'warn', 'Ссылка устарела: теперь код — 6 цифр. Попросите у врача новую.');
} else if (codeDigits(fromLink)) {
  ui.code.value = fromLink;
  readCode();
}
