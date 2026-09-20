//
//  Оболочка Vidi в браузере. Этап 5 — вход по подписке и правило «одно место за
//  раз». Просмотр пока каркас: ни DICOM, ни архивов здесь ещё нет.
//
//  Два правила действуют с самого начала, чтобы позже их не пришлось вносить
//  через весь код:
//  • наружу не уходит ничего — ни имён файлов, ни данных пациента, ни отчётов
//    об ошибках. На экране только код ошибки, который врач называет вслух;
//  • из данных браузер помнит только вход (см. auth.js) — снимки не хранятся.
//

import {
  auth, activate, check, signOut, seat, storageWorks, describeHolder, SEAT_PING_MS,
} from './auth.js?v=2';
import { openArchive, progressOf, ArchiveError, ArchiveCancelled } from './archive.js?v=1';

const VERSION = '0.4.0';
const STAGE = 'снимки';

// ─── Мелкие помощники ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function setNotice(el, text) {
  el.textContent = text ?? '';
  el.hidden = !text;
}

/** «2 дня» / «5 дней» — иначе получается «осталось 2 дней». */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Убираем хвост «г.»: дальше в предложении идёт точка, и получалось «2025 г..».
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.\s*$/, '');
}

// ─── Ошибки ────────────────────────────────────────────────────────────────

const errorSheet = $('error-sheet');

/**
 * Показывает ошибку врачу. `code` — короткая метка для разговора с поддержкой,
 * `text` — что делать. Подробности остаются в консоли и никуда не отправляются.
 */
function showError(code, text, detail) {
  $('error-code').textContent = code;
  $('error-text').textContent = text;
  errorSheet.hidden = false;
  if (detail) console.error(`[${code}]`, detail);
}

$('error-close').addEventListener('click', () => { errorSheet.hidden = true; });

// Необработанный сбой не должен выглядеть как «приложение зависло».
window.addEventListener('error', (e) => {
  showError('APP-1', 'Что-то пошло не так. Перезагрузите страницу.', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  showError('APP-2', 'Что-то пошло не так. Перезагрузите страницу.', e.reason);
});

// ─── Экраны ────────────────────────────────────────────────────────────────

const screens = {
  boot: $('screen-boot'),
  login: $('screen-login'),
  blocked: $('screen-blocked'),
  start: $('screen-start'),
  open: $('screen-open'),
  study: $('screen-study'),
  viewer: $('screen-viewer'),
};

let current = 'boot';

function showScreen(name) {
  current = name;
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name === 'viewer') layoutAllPanes();
}

// ─── Проверка браузера ─────────────────────────────────────────────────────

/**
 * Проверяем то, без чего версия в браузере работать не сможет, и говорим об
 * этом СРАЗУ. Иначе врач выберет архив на 600 МБ, подождёт, и только потом
 * узнает, что его браузер не тянет.
 *
 * MAX_3D_TEXTURE_SIZE проверяем не из любопытства: объём КТ грузится в
 * трёхмерную текстуру целиком, и предел меньше 512 означает, что 3D и наклон
 * осей на этом устройстве не получатся.
 *
 * Память браузера здесь тоже не ради полноты: без неё каждое открытие страницы
 * станет новым устройством, а браузерный слот у подписки один.
 */
function checkEnvironment() {
  const rows = [];
  let blocking = null;

  const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  rows.push(['Распаковка архивов', hasWasm]);
  if (!hasWasm) blocking = 'ENV-WASM';

  const hasWorker = typeof Worker === 'function';
  rows.push(['Фоновая обработка', hasWorker]);
  if (!hasWorker && !blocking) blocking = 'ENV-WORKER';

  const hasFile = typeof File === 'function' && typeof FileReader === 'function' && typeof Blob === 'function';
  rows.push(['Чтение файлов', hasFile]);
  if (!hasFile && !blocking) blocking = 'ENV-FILE';

  let gl = null;
  let maxTex3D = 0;
  try {
    const probe = document.createElement('canvas');
    gl = probe.getContext('webgl2');
    if (gl) maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) | 0;
  } catch (e) {
    gl = null;
  }
  rows.push(['Отрисовка снимка', !!gl]);
  if (!gl && !blocking) blocking = 'ENV-GL2';

  if (gl) {
    const enough = maxTex3D >= 512;
    rows.push(['Объём для 3D', enough, enough ? 'до ' + maxTex3D : 'мало']);
    if (!enough && !blocking) blocking = 'ENV-TEX3D';
  }

  // Потерять контекст сразу, а не ждать сборщик мусора: на телефоне число
  // одновременных WebGL-контекстов ограничено.
  if (gl) {
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  const canRemember = storageWorks();
  rows.push(['Память входа', canRemember]);
  if (!canRemember && !blocking) blocking = 'ENV-STORE';

  return { rows, blocking };
}

function renderEnvironment() {
  const { rows, blocking } = checkEnvironment();
  const dl = $('env-rows');
  dl.textContent = '';

  for (const [label, ok, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value ?? (ok ? 'есть' : 'нет');
    dd.className = ok ? 'ok' : 'bad';
    dl.append(dt, dd);
  }

  const hint = $('env-hint');
  if (blocking === 'ENV-STORE') {
    // Отдельный текст: дело не в старом браузере, а в приватном окне или
    // запрете данных сайта. Пускать сюда нельзя — вход привяжется и тут же
    // забудется, а браузерный слот у подписки один.
    hint.textContent = 'Браузер не сохраняет вход — обычно это приватное окно или запрет данных сайта. Откройте Vidi в обычном окне, иначе вход придётся привязывать заново каждый раз. Код ENV-STORE.';
    hint.hidden = false;
    $('login-submit').disabled = true;
  } else if (blocking) {
    hint.textContent = 'Этот браузер не сможет открыть КТ. Обновите его или откройте Vidi в Safari либо Chrome. Код ' + blocking + '.';
    hint.hidden = false;
    $('login-submit').disabled = true;
  } else {
    hint.hidden = true;
  }
  return blocking;
}

// ─── Вход ──────────────────────────────────────────────────────────────────

const loginForm = $('login-form');
const loginNotice = $('login-notice');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email').value.trim().toLowerCase();
  const code = $('login-code').value.trim().toUpperCase();

  if (!email || !code) { setNotice(loginNotice, 'Введите почту и код.'); return; }
  if (!$('login-agree').checked) {
    setNotice(loginNotice, 'Отметьте согласие с условиями.');
    return;
  }

  const btn = $('login-submit');
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  setNotice(loginNotice, '');

  const r = await activate(email, code);

  btn.disabled = false;
  btn.textContent = 'Войти';

  switch (r.result) {
    case 'ok':
      startSession();
      break;
    case 'locked':
      // Для сервера это успех: код верный, браузер привязан. Молчать здесь
      // нельзя — врач увидит, что «ничего не произошло».
      showBlocked('Код верный, вход выполнен — но доступ пока закрыт.',
        r.paidUntil ? 'Подписка закончилась ' + formatDate(r.paidUntil) + '.'
                    : 'Подписка не оплачена. Если оплата была — напишите в поддержку.');
      break;
    case 'badCode':
      setNotice(loginNotice, 'Код не подошёл. Проверьте раскладку и пробелы.');
      break;
    case 'notFound':
      setNotice(loginNotice, 'Такой почты нет. Проверьте адрес или зарегистрируйтесь в боте.');
      break;
    case 'deviceLimit':
      setNotice(loginNotice, 'К этой подписке уже привязан другой браузер. ' +
        'Отвяжите его кнопкой в боте — ' +
        (r.resetsLeft > 0
          ? 'осталось ' + r.resetsLeft + ' ' + plural(r.resetsLeft, 'сброс', 'сброса', 'сбросов') + ' в этом месяце.'
          : 'сбросы в этом месяце закончились.'));
      break;
    case 'tooManyAttempts': {
      const min = r.retryAfter ? Math.ceil(r.retryAfter / 60) : null;
      setNotice(loginNotice, min
        ? `Слишком много попыток. Повторите через ${min} ${plural(min, 'минуту', 'минуты', 'минут')}.`
        : 'Слишком много попыток. Повторите позже.');
      break;
    }
    case 'storage':
      setNotice(loginNotice, 'Браузер не сохранил вход. Откройте Vidi в обычном окне, не в приватном.');
      break;
    case 'network':
      setNotice(loginNotice, 'Нет связи с сервером. Проверьте интернет.');
      break;
    default:
      setNotice(loginNotice, 'Не получилось войти. Попробуйте ещё раз.');
  }
});

// ─── Доступ закрыт ─────────────────────────────────────────────────────────

function showBlocked(title, text) {
  $('blocked-title').textContent = title;
  $('blocked-text').textContent = text;
  $('blocked-email').textContent = auth.email || auth.savedEmail
    ? 'Аккаунт: ' + (auth.email || auth.savedEmail)
    : '';
  stopSeat();
  showScreen('blocked');
}

$('blocked-retry').addEventListener('click', () => { boot(); });

$('blocked-signout').addEventListener('click', async () => {
  const r = await signOut();
  if (r.result === 'resetLimit') {
    $('blocked-text').textContent = r.retryAfterDays
      ? `Сбросы закончились: следующий через ${r.retryAfterDays} ${plural(r.retryAfterDays, 'день', 'дня', 'дней')}. Выйти сейчас нельзя.`
      : 'Сбросы в этом месяце закончились. Выйти сейчас нельзя.';
    return;
  }
  showLogin();
});

// ─── Сессия ────────────────────────────────────────────────────────────────

function showLogin() {
  stopSeat();
  const email = auth.savedEmail;
  if (email) $('login-email').value = email;
  showScreen('login');
}

function startSession() {
  $('account-email').textContent = auth.email ?? '—';
  $('account-paid').textContent = auth.paidUntil ? formatDate(auth.paidUntil) : '—';
  setNotice($('signout-notice'), '');
  showScreen('start');
  startSeat();
}

$('btn-signout').addEventListener('click', async () => {
  const btn = $('btn-signout');
  btn.disabled = true;
  const r = await signOut();
  btn.disabled = false;

  if (r.result === 'ok') { showLogin(); return; }
  if (r.result === 'resetLimit') {
    setNotice($('signout-notice'), r.retryAfterDays
      ? `Сбросы закончились: следующий через ${r.retryAfterDays} ${plural(r.retryAfterDays, 'день', 'дня', 'дней')}.`
      : 'Сбросы в этом месяце закончились.');
    return;
  }
  if (r.result === 'network') {
    setNotice($('signout-notice'), 'Нет связи с сервером. Попробуйте позже.');
    return;
  }
  setNotice($('signout-notice'), 'Не получилось выйти. Попробуйте позже.');
});

// ─── Рабочее место ─────────────────────────────────────────────────────────

const seatSheet = $('seat-sheet');
let seatTimer = null;
let seatFailures = 0;
let seatTaken = false;

// Столько подряд неудачных обращений держим прежнюю картину. Обрыв связи не
// имеет права закрыть врачу снимок: три пропуска — и экран отпускает сам.
const SEAT_FAILURES_BEFORE_RELEASE = 3;

function showSeatTaken(holder) {
  seatTaken = true;
  $('seat-text').textContent = 'Сейчас снимок открыт здесь: ' + holder + '.';
  seatSheet.hidden = false;
}

function hideSeatTaken() {
  seatTaken = false;
  seatSheet.hidden = true;
}

async function pingSeat({ claim = false } = {}) {
  const r = await seat({ claim });

  switch (r.result) {
    case 'mine':
      seatFailures = 0;
      hideSeatTaken();
      break;
    case 'taken':
      seatFailures = 0;
      showSeatTaken(r.holder);
      break;
    case 'revoked':
      stopSeat();
      showBlocked('Браузер отвязан',
        'Эту привязку сняли — в боте или на другом устройстве. Войдите заново.');
      break;
    case 'offline':
      seatFailures += 1;
      // Долгий обрыв: перестаём утверждать, что место у кого-то другого.
      if (seatTaken && seatFailures >= SEAT_FAILURES_BEFORE_RELEASE) hideSeatTaken();
      break;
    default:
      // Непонятный ответ не должен запирать работу.
      hideSeatTaken();
  }
}

function startSeat() {
  stopSeat();
  seatFailures = 0;
  pingSeat();
  seatTimer = setInterval(pingSeat, SEAT_PING_MS);
}

function stopSeat() {
  if (seatTimer) clearInterval(seatTimer);
  seatTimer = null;
  hideSeatTaken();
}

$('seat-claim').addEventListener('click', async () => {
  const btn = $('seat-claim');
  btn.disabled = true;
  await pingSeat({ claim: true });
  btn.disabled = false;
});

// Вкладку вернули из фона — спрашиваем сразу, не дожидаясь таймера: за это
// время место мог занять Mac.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && seatTimer) pingSeat();
});

// ─── Панели просмотра ──────────────────────────────────────────────────────

const panes = Array.from(document.querySelectorAll('.pane'));
const planeTabs = Array.from(document.querySelectorAll('.plane-tab'));

function selectPlane(plane) {
  for (const pane of panes) pane.classList.toggle('is-active', pane.dataset.plane === plane);
  for (const tab of planeTabs) {
    const on = tab.dataset.plane === plane;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  layoutAllPanes();
}

for (const tab of planeTabs) {
  tab.addEventListener('click', () => selectPlane(tab.dataset.plane));
}

/**
 * Размер canvas в пикселях устройства. Плотность режем до 2: на телефоне
 * третий пиксель уже не виден, а площадь растёт в полтора раза — это прямо
 * столько же работы на каждый кадр.
 */
function layoutPane(pane) {
  const canvas = pane.querySelector('.pane-canvas');
  if (!canvas || pane.offsetParent === null) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  drawPlaceholder(canvas);
}

function layoutAllPanes() {
  for (const pane of panes) layoutPane(pane);
}

/**
 * Заглушка вместо снимка: сетка и перекрестие. Нужна не для красоты — по ней
 * на телефоне сразу видно, если canvas посчитан неверно: клетки станут
 * прямоугольными, а перекрестие уедет из центра.
 */
function drawPlaceholder(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const step = Math.max(24, Math.round(Math.min(w, h) / 8));
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
  ctx.stroke();

  const cx = Math.round(w / 2) + .5;
  const cy = Math.round(h / 2) + .5;
  const arm = Math.round(Math.min(w, h) * 0.06);
  ctx.strokeStyle = 'rgba(79,156,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
  ctx.stroke();
}

// Пересчитываем при повороте телефона, изменении окна и уходе полосы Safari.
const resizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => layoutAllPanes())
  : null;
if (resizeObserver) for (const pane of panes) resizeObserver.observe(pane);
window.addEventListener('resize', layoutAllPanes);
window.addEventListener('orientationchange', () => setTimeout(layoutAllPanes, 200));

// ─── Открытие архива ───────────────────────────────────────────────────────

const fileInput = $('file-input');

$('btn-open').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  // Сбрасываем сразу: иначе повторный выбор того же файла не даёт события.
  fileInput.value = '';
  if (file) runOpen(file);
});

function showOpenProgress(stats) {
  const fraction = progressOf(stats);
  const bar = $('open-bar');
  if (fraction === null) {
    bar.classList.add('is-unknown');
    bar.style.width = '';
  } else {
    bar.classList.remove('is-unknown');
    bar.style.width = Math.round(fraction * 100) + '%';
  }
  $('open-found').textContent = String(stats.dicom ?? 0);
  const sec = Math.round((stats.elapsedMs ?? 0) / 1000);
  $('open-time').textContent = sec + ' с';
}

let openAbort = null;

async function runOpen(file) {
  openAbort?.abort();
  openAbort = new AbortController();
  const abort = openAbort;
  showScreen('open');
  $('open-title').textContent = 'Открываем архив';
  showOpenProgress({ dicom: 0, elapsedMs: 0 });

  // Распаковка идёт в отдельном потоке, поэтому сигнал «я открыт» продолжает
  // уходить раз в 45 секунд. Иначе долгий архив выглядел бы как простой, и
  // место отдали бы другому устройству прямо посреди работы.
  try {
    const found = await openArchive(file, {
      onProgress: showOpenProgress,
      signal: abort.signal,
    });
    showFoundStudy(found);
  } catch (e) {
    if (e instanceof ArchiveCancelled) return; // экран уже вернули по нажатию
    showScreen('start');
    if (e instanceof ArchiveError) showError(e.code, e.text);
    else showError('ARC-0', 'Не удалось открыть архив.', e);
  } finally {
    if (openAbort === abort) openAbort = null;
  }
}

// ─── Что нашлось в архиве ──────────────────────────────────────────────────

let foundStudy = null;
let chosenSeries = null;

/** Имя из DICOM: «Иванов^Иван^Иванович» — это разделители, а не знаки. */
function personName(raw) {
  const name = (raw || '').split('^').map((p) => p.trim()).filter(Boolean).join(' ');
  return name || 'Без имени';
}

/** Дата исследования приходит как ГГГГММДД. */
function studyDate(raw) {
  if (!/^\d{8}$/.test(raw || '')) return '';
  const d = new Date(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)) - 1, Number(raw.slice(6, 8)));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.\s*$/, '');
}

function seriesTitle(s) {
  if (s.description) return s.description;
  if (s.number !== null && s.number !== undefined) return 'Серия ' + s.number;
  return 'Серия без названия';
}

/** Почему серию нельзя открыть. null — можно. */
function seriesBlocker(s) {
  if (s.bitsAllocated !== 16) return 'Не объём КТ: ' + s.bitsAllocated + '-битные снимки.';
  if (s.compressed) return 'Снимки сжаты — Vidi в браузере пока их не разбирает.';
  if (s.slices < 10) return 'Слишком мало срезов для объёма.';
  return null;
}

function showFoundStudy(found) {
  foundStudy = found;
  const study = found.study;

  $('study-patient').textContent = personName(study.patientName);
  const date = studyDate(study.studyDate);
  const total = found.stats.dicom;
  $('study-sub').textContent = [date, 'снимков: ' + total].filter(Boolean).join(' · ');

  const list = $('series-list');
  list.textContent = '';
  chosenSeries = null;

  for (const s of study.series) {
    const blocker = seriesBlocker(s);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'series-item';
    item.disabled = !!blocker;

    const name = document.createElement('div');
    name.className = 'series-name';
    name.textContent = seriesTitle(s);

    const meta = document.createElement('div');
    meta.className = 'series-meta';
    const size = s.columns && s.rows ? s.columns + '×' + s.rows : '';
    meta.textContent = [s.slices + ' ' + plural(s.slices, 'срез', 'среза', 'срезов'), size]
      .filter(Boolean).join(' · ');

    item.append(name, meta);
    if (blocker) {
      const warn = document.createElement('div');
      warn.className = 'series-warn';
      warn.textContent = blocker;
      item.append(warn);
    } else if (!chosenSeries) {
      // Список уже отсортирован: первая пригодная и есть та самая КТ.
      chosenSeries = s;
      item.classList.add('is-chosen');
    }

    item.addEventListener('click', () => {
      chosenSeries = s;
      for (const el of list.children) el.classList.remove('is-chosen');
      item.classList.add('is-chosen');
      updateStudyHint();
    });

    list.append(item);
  }

  updateStudyHint();
  showScreen('study');
}

function updateStudyHint() {
  const openable = !!chosenSeries;
  $('study-open').disabled = !openable;
  $('series-hint').textContent = openable
    ? 'Открывается выбранная серия. Остальные — служебные снимки из того же архива.'
    : 'В этом архиве нет серии, которую Vidi может открыть.';
}

$('study-back').addEventListener('click', () => showScreen('start'));

$('study-open').addEventListener('click', () => {
  if (!chosenSeries) return;
  showScreen('viewer');
  $('patient').textContent = personName(foundStudy.study.patientName);
  const plate = $('plate');
  plate.textContent = seriesTitle(chosenSeries) + ': ' + chosenSeries.slices + ' ' +
    plural(chosenSeries.slices, 'срез', 'среза', 'срезов') + ', ' +
    chosenSeries.columns + '×' + chosenSeries.rows +
    '. Построение объёма — на следующем этапе.';
  plate.hidden = false;
});

$('open-cancel').addEventListener('click', () => {
  openAbort?.abort();
  showScreen('start');
});

$('btn-back').addEventListener('click', () => showScreen(foundStudy ? 'study' : 'start'));

// ─── Запуск ────────────────────────────────────────────────────────────────

const versionLabel = VERSION + ' · ' + STAGE;
$('version-login').textContent = 'Vidi ' + versionLabel;
$('version-start').textContent = 'Vidi ' + versionLabel;
$('version-blocked').textContent = 'Vidi ' + versionLabel;
$('version-viewer').textContent = versionLabel;

async function boot() {
  showScreen('boot');
  $('boot-text').textContent = 'Проверяем доступ…';

  const blocking = renderEnvironment();
  if (blocking) { showLogin(); return; }

  if (!auth.signedIn) { showLogin(); return; }

  const r = await check();
  switch (r.result) {
    case 'ok':
      startSession();
      break;
    case 'expired':
      showBlocked('Подписка не активна',
        r.paidUntil
          ? 'Подписка закончилась ' + formatDate(r.paidUntil) + '. Продлите её в боте.'
          : 'Подписка не оплачена. Если оплата была — напишите в поддержку.');
      break;
    case 'revoked':
      showLogin();
      setNotice(loginNotice, 'Привязку этого браузера сняли. Войдите заново.');
      break;
    case 'offline':
      showBlocked('Нет связи с сервером',
        'Vidi в браузере проверяет подписку при каждом открытии. Проверьте интернет и повторите.');
      break;
    default:
      showBlocked('Не удалось проверить доступ', 'Попробуйте ещё раз.');
  }
}

boot();
