// Этап 0: страница вокруг worker.js. Кроме распаковки проверяет, стирает ли
// браузер данные сайта сам (от этого зависит, будет ли вход в Vidi забываться).

// Меняется вместе с ?v= в index.html: без этого Safari может взять старый воркер из кеша.
const VERSION = 2;
const RUN_KEY = 'vidi-spike-run';
const FIRST_SEEN_KEY = 'vidi-spike-first-seen';
const COOKIE_NAME = 'vidi_spike_first';

const $ = (id) => document.getElementById(id);

const FORMAT_NAMES = {
  zip: 'ZIP', rar: 'RAR', rar5: 'RAR5', '7z': '7z', gz: 'GZIP', bz2: 'BZIP2', xz: 'XZ', tar: 'TAR',
  dicom: 'Файл DICOM', unknown: 'не архив',
};

const REASONS = {
  'unknown-format': 'Это не архив, который умеет открывать Vidi.',
  'too-deep': 'Слишком много архивов внутри архивов (больше 4).',
  '7z:fatal': '7-Zip не смог распаковать архив: он повреждён или защищён паролем.',
  '7z:memory': '7-Zip не хватило памяти.',
  '7z:warning': 'Архив распакован с предупреждениями: часть файлов могла не прочитаться.',
};

const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} МБ`;
const sec = (ms) => `${(ms / 1000).toFixed(1)} с`;

function readRun() {
  try { return JSON.parse(sessionStorage.getItem(RUN_KEY)); } catch { return null; }
}
function writeRun(value) {
  try {
    if (value) sessionStorage.setItem(RUN_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(RUN_KEY);
  } catch { /* приватный режим — проверка вылета просто не сработает */ }
}

function row(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

function renderNumbers(s) {
  const dl = $('numbers');
  dl.replaceChildren();
  row(dl, 'Формат', FORMAT_NAMES[s.format] ?? s.format ?? '—');
  row(dl, 'Размер архива', mb(s.archiveBytes));
  row(dl, 'Распаковано', mb(s.bytesOut));
  row(dl, 'Файлов', String(s.files));
  row(dl, 'Из них DICOM', String(s.dicom));
  if (s.nested) row(dl, 'Архивов внутри', String(s.nested));
  if (s.encrypted) row(dl, 'С паролем (пропущены)', String(s.encrypted));
  row(dl, 'Самый большой файл', mb(s.largestFile));
  row(dl, 'Время', sec(s.elapsedMs));
  if (s.elapsedMs > 0) row(dl, 'Скорость', `${(s.bytesOut / 1048576 / (s.elapsedMs / 1000)).toFixed(0)} МБ/с`);
  if (s.firstFileMs !== null) row(dl, 'До первого файла', sec(s.firstFileMs));
  // Разбивка по шагам — только для RAR/7z, где работает 7-Zip.
  if (s.sevenZipRuns > 0) {
    row(dl, 'Запуск 7-Zip', sec(s.wasmInitMs));
    row(dl, 'Оглавление', sec(s.listMs));
    row(dl, 'Распаковка', sec(s.extractMs));
    if (s.nestedMs > 0) row(dl, 'Вложенные архивы', sec(s.nestedMs));
    row(dl, 'Чтений с диска', `${s.readCalls} за ${sec(s.readMs)}`);
  }
}

function setStatus(text, tone) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${tone ?? ''}`;
}

// Если прошлый запуск не дошёл до конца, а вкладка перезагрузилась, —
// почти наверняка iOS выгрузила страницу из-за нехватки памяти.
function showCrash() {
  const run = readRun();
  if (!run) return;
  writeRun(null);
  const box = $('crash');
  box.hidden = false;
  box.replaceChildren();
  const title = document.createElement('div');
  title.className = 'status bad';
  title.textContent = 'Прошлая проверка не завершилась — страница перезагрузилась';
  const text = document.createElement('p');
  text.textContent = `Так бывает, когда телефону не хватает памяти. Архив ${mb(run.archiveBytes)}, `
    + `успело распаковаться ${run.files} файлов (${mb(run.bytesOut)}) за ${sec(run.elapsedMs)}.`;
  box.append(title, text);
}

function run(file) {
  $('pickLabel').setAttribute('aria-disabled', 'true');
  setStatus('Распаковка…');
  $('numbers').replaceChildren();
  writeRun({ archiveBytes: file.size, files: 0, bytesOut: 0, elapsedMs: 0 });

  const worker = new Worker(new URL(`./worker.js?v=${VERSION}`, import.meta.url), { type: 'module' });
  const finish = () => {
    worker.terminate();
    writeRun(null);
    $('pickLabel').removeAttribute('aria-disabled');
    $('pick').value = '';
  };

  worker.onmessage = ({ data }) => {
    const s = data.stats;
    renderNumbers(s);
    if (data.type === 'progress') {
      writeRun({ archiveBytes: s.archiveBytes, files: s.files, bytesOut: s.bytesOut, elapsedMs: s.elapsedMs });
      setStatus(`Распаковка… ${s.files} файлов`);
    } else if (data.type === 'done') {
      finish();
      if (s.dicom === 0) setStatus('Архив распакован, но DICOM-файлов в нём нет.', 'warn');
      else setStatus('Готово: архив распакован целиком.', 'ok');
      window.__spikeResult = { ok: true, stats: s };
    } else if (data.type === 'failed') {
      finish();
      setStatus(REASONS[data.reason] ?? `Не получилось (код: ${data.reason}).`, 'bad');
      window.__spikeResult = { ok: false, reason: data.reason, stats: s };
    }
  };
  worker.onerror = (event) => {
    finish();
    event.preventDefault();
    setStatus('Не удалось запустить распаковку в этом браузере.', 'bad');
    window.__spikeResult = { ok: false, reason: 'worker-error' };
  };

  const query = new URLSearchParams(location.search);
  worker.postMessage({ file, debugGc: query.has('gc'), noReadAhead: query.has('noreadahead') });
}

function daysSince(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (!Number.isFinite(days)) return '—';
  if (days <= 0) return 'сегодня';
  return `${days} дн. назад`;
}

function readCookie() {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : null;
}

function renderStorage() {
  const now = new Date().toISOString();
  let stored = null;
  try {
    stored = localStorage.getItem(FIRST_SEEN_KEY);
    if (!stored) localStorage.setItem(FIRST_SEEN_KEY, now);
  } catch { /* недоступно */ }
  let cookie = readCookie();
  if (!cookie) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(now)}; Max-Age=34560000; Path=/; SameSite=Lax${secure}`;
  }
  const dl = $('storage');
  dl.replaceChildren();
  row(dl, 'По памяти страницы', stored ? daysSince(stored) : 'сегодня');
  row(dl, 'По cookie', cookie ? daysSince(cookie) : 'сегодня');
}

$('pick').addEventListener('change', () => {
  const file = $('pick').files?.[0];
  if (file) run(file);
});

$('device').textContent = `Версия ${VERSION} · ${navigator.userAgent} · ядер: ${navigator.hardwareConcurrency ?? '?'}`
  + ` · DecompressionStream: ${'DecompressionStream' in window ? 'есть' : 'нет'}`
  + ` · WebGL 2: ${document.createElement('canvas').getContext('webgl2') ? 'есть' : 'нет'}`;

showCrash();
renderStorage();
