// Страница отправки КТ: код врача → папка со снимком → шифрование в браузере →
// загрузка частями прямо в хранилище. Сервер Vidi видит только зашифрованное.
// С этапа 8 уходит папка целиком — Vidi сам найдёт в ней КТ; если пациентов в
// папке несколько, отправитель один раз выбирает, чей снимок (plan.js).

// Номер версии — в адресах всех файлов страницы (?v=8) и в <html data-version>.
import {
  makeEnvelope, sealMeta, sealChunk, containerStream, compress, chunks, toBase64, fromBase64,
} from './pack.js?v=8';
import { peek, sniffArchive } from './dicom-peek.js?v=8';
import { peekZip } from './zip-peek.js?v=8';
import { classify, sortOut, fit, describe } from './plan.js?v=8';
import { CODE_DIGITS, codeValid, codeDigits, formatCode, isOldCode } from './code.js?v=8';

// Страница и скрипт — одной версии. Браузер мог взять страницу из своей памяти, а скрипт
// с сайта (так было у Safari 19.10: шаг «Снимок» опустел). Не совпало — один раз загрузить
// страницу заново: адрес с ?v= для браузера новый, из памяти его не взять.
const VERSION = '8';
if (document.documentElement.dataset.version !== VERSION) {
  const params = new URLSearchParams(location.search);
  if (params.get('v') !== VERSION) {
    params.set('v', VERSION);
    location.replace(`${location.pathname}?${params}${location.hash}`);
  }
}

const LOCAL = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const API = LOCAL ? (new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8932')
  : 'https://api.vidiviewer.ru';
const PARALLEL_UPLOADS = 2;
const SCAN_WORKERS = 8;

const $ = (id) => document.getElementById(id);
const ui = {
  code: $('code'), codeStatus: $('code-status'),
  files: $('step-files'), drop: $('drop'), folderInput: $('folder-input'), filesInput: $('files-input'),
  scan: $('scan'), scanCount: $('scan-count'), scanBar: $('scan-bar'),
  found: $('found'), ask: $('ask'), list: $('found-list'), note: $('note'), foundStatus: $('found-status'),
  send: $('send'), again: $('again'),
  stepSend: $('step-send'), sendTitle: $('send-title'), sendBar: $('send-bar'), sendStatus: $('send-status'),
  sendFail: $('send-fail'), retry: $('retry'),
  done: $('step-done'), more: $('more'),
};

const state = {
  code: null, recipient: null, maxBytes: 0, checkSeq: 0,
  sorted: null, choice: null, plan: null, busy: false,
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
  try {
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
  } catch {
    // Недоступное браузеру (системные папки диска) пропускаем — остальное уйдёт.
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

// ---------- Разбор: что в папке ----------

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} ГБ`
  : `${Math.max(1, Math.round(bytes / 1e6))} МБ`).replace('.', ',');

const filesWord = (n) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} файл`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} файла`;
  return `${n} файлов`;
};

// Чем читать файлы при разборе: заголовок снимка, оглавление ZIP, первые байты.
const IO = { peek, peekZip, sniffArchive };

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
  const scanned = [];
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
        result = await classify(entry.path, entry.file, IO);
      } catch {
        result = { kind: 'other' };
      }
      if (result.kind !== 'junk') scanned.push({ ...entry, size: entry.file.size, ...result });
      done += 1;
      if (done % 25 === 0) tick();
    }
  }
  await Promise.all(Array.from({ length: SCAN_WORKERS }, worker));
  tick();

  // Файлы — в порядке папки: читали их в несколько потоков.
  scanned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  state.sorted = sortOut(scanned);
  state.busy = false;
  showFound();
}

const modalityWord = (modality) => (modality === 'CT' ? 'КТ' : modality);

function optionInfo(option) {
  if (option.kind === 'person') {
    const { modality, date } = option.info;
    return [modalityWord(modality), date, mb(option.bytes)].filter(Boolean).join(' · ');
  }
  const where = option.patients ? 'несколько пациентов' : option.folder;
  return ['Архив', where, mb(option.bytes)].filter(Boolean).join(' · ');
}

function foundItem(title, info, option) {
  const li = document.createElement('li');
  li.className = 'found-item';
  const what = document.createElement('div');
  what.className = 'what';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = title;
  const line = document.createElement('div');
  line.className = 'info';
  line.textContent = info;
  what.append(who, line);
  if (!option) {
    li.classList.add('on', 'whole');
    li.append(what);
    return li;
  }
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'who';
  radio.setAttribute('aria-label', title);
  li.append(radio, what);
  const choose = () => {
    state.choice = option;
    radio.checked = true;
    for (const other of ui.list.children) other.classList.toggle('on', other === li);
    update();
  };
  radio.addEventListener('change', choose);
  li.addEventListener('click', (e) => { if (e.target !== radio) choose(); });
  return li;
}

function showFound() {
  const { mode, options, person, folder } = state.sorted;
  ui.scan.hidden = true;
  ui.list.textContent = '';
  state.choice = null;
  // Несколько пациентов — один вопрос «чей снимок»: в общей папке клиники лежат и чужие.
  ui.ask.hidden = mode !== 'choose';
  if (mode === 'whole') {
    const title = person?.title || folder || (options.length === 1 ? options[0].title : 'Выбранные файлы');
    const info = person
      ? [modalityWord(person.info.modality), person.info.date].filter(Boolean).join(' · ') || 'Снимок'
      : 'Папка';
    ui.list.append(foundItem(title, info, null));
  } else if (mode === 'choose') {
    for (const option of options) ui.list.append(foundItem(option.title, optionInfo(option), option));
  }
  ui.found.hidden = false;
  update();
}

function update() {
  const { mode, whole, core } = state.sorted;
  let plan = null;
  if (mode === 'whole') plan = fit(whole, state.maxBytes, core);
  else if (mode === 'choose' && state.choice) plan = fit(state.choice, state.maxBytes);
  state.plan = plan;

  let note = '';
  if (mode === 'whole' && plan?.trimmed) {
    note = `Папка больше ${mb(state.maxBytes)} — отправятся только снимки и архивы. Программы и картинки Vidi не нужны.`;
  } else if (mode === 'whole' && plan) {
    note = `Отправится вся папка — ${filesWord(whole.entries.length)}. Vidi сам найдёт в ней КТ.`;
  } else if (mode === 'choose') {
    note = 'Другие пациенты и остальные файлы папки не отправятся.';
  }
  ui.note.hidden = !note;
  ui.note.textContent = note;

  if (mode === 'empty' && state.sorted.unsupported.length) {
    // 7z, tar, gz Vidi не открывает: отправлять такой архив незачем.
    const names = state.sorted.unsupported.slice(0, 2).map((n) => `«${n}»`).join(', ');
    setStatus(ui.foundStatus, 'warn', `${state.sorted.unsupported.length > 1 ? 'Архивы' : 'Архив'} ${names} `
      + 'Vidi пока не открывает. Распакуйте и перетащите сюда получившуюся папку.');
  } else if (mode === 'empty') {
    setStatus(ui.foundStatus, 'warn', 'Снимков КТ не нашлось: ни файлов DICOM, ни архивов. Выберите другую папку или весь диск.');
  } else if (mode === 'choose' && !state.choice) {
    setStatus(ui.foundStatus, '', 'Выберите, чей снимок отправить.');
  } else if (!plan) {
    setStatus(ui.foundStatus, 'warn', `Больше ${mb(state.maxBytes)} за раз не отправить.`);
  } else {
    setStatus(ui.foundStatus, '', `К отправке: ${mb(plan.bytes)}`);
  }
  ui.send.disabled = !plan;
}

function reset() {
  ui.found.hidden = true;
  ui.drop.hidden = false;
  state.sorted = null;
  state.choice = null;
  state.plan = null;
}

ui.again.addEventListener('click', reset);

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
  const { entries, bytes: total } = state.plan;
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
    const meta = { v: 1, compression, ...describe(entries), sent_at: new Date().toISOString() };
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

ui.send.addEventListener('click', () => { if (!state.busy && state.plan) send(); });
ui.retry.addEventListener('click', () => { if (!state.busy && state.plan) send(); });
ui.more.addEventListener('click', () => {
  ui.done.hidden = true;
  ui.files.hidden = false;
  reset();
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
