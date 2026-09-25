//
//  Оболочка Vidi в браузере: вход по подписке, правило «одно место за раз»,
//  открытие архива и выбор серии. Сам просмотр — отдельный модуль, который
//  сервер отдаёт только вошедшему устройству (см. loadViewer).
//
//  Два правила действуют с самого начала, чтобы позже их не пришлось вносить
//  через весь код:
//  • наружу не уходит ничего — ни имён файлов, ни данных пациента, ни отчётов
//    об ошибках. На экране только код ошибки, который врач называет вслух;
//  • из данных браузер помнит только вход (см. auth.js) — снимки не хранятся.
//

import {
  auth, activate, check, signOut, seat, storageWorks, SEAT_PING_MS, moduleTicket, moduleURL,
} from './auth.js?v=0.9.5';
import { openArchive, progressOf, ArchiveError, ArchiveCancelled, buildVolume } from './archive.js?v=0.9.5';

/*
  Код просмотра НЕ лежит рядом файлом. Браузерная версия считает снимок сама,
  серверу для просмотра не нужно ничего — значит, лежи просмотр на сайте, им
  можно было бы пользоваться, вообще не входя. Поэтому он подгружается с
  сервера по короткому билету, который выдаётся устройству с действующей
  подпиской. Порог, а не замок: вошедший может сохранить код из браузера.
*/
let V = null;            // модуль просмотра, пока не загружен — null

async function loadViewer() {
  if (V) return V;
  const ticket = await moduleTicket();
  if (!ticket) throw new Error('module-denied');
  let mod;
  try {
    mod = await import(moduleURL('viewer.js', ticket));
  } catch (e) {
    // Билет выдан, а файл не дошёл: оборвалась связь или билет истёк на
    // медленном телефоне. Для врача это тот же отказ в доступе к просмотру,
    // а не «не удалось построить объём».
    console.error('[APP-3]', e);
    throw new Error('module-denied');
  }
  mod.attachViewer({ onContextLost: viewerLost });
  V = mod;
  return V;
}

const VERSION = '0.9.5';

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

/**
 * Когда устройство заходило в последний раз. Точное время сегодняшнего входа
 * отвечает на главный вопрос врача: это я сам полчаса назад или кто-то другой.
 */
function whenSeen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400000);
  if (days === 0) return 'сегодня в ' + time;
  if (days === 1) return 'вчера в ' + time;
  return formatDate(iso);
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
  if (name === 'viewer') V?.layoutViewer();
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
    case 'deviceLimit': {
      // Чаще всего сюда упирается не чужой браузер, а свой же: Safari очистил
      // данные сайта, вход потерялся, и тот же телефон пришёл под новым
      // номером. Поэтому называем, кто держит слот и когда заходил — иначе
      // отказ выглядит так, будто подписку кто-то занял.
      const who = r.bound
        ? 'Занят: ' + r.bound.name +
          (r.bound.lastSeen ? ', заходил ' + whenSeen(r.bound.lastSeen) : '') + '. '
        : '';
      setNotice(loginNotice, 'К этой подписке уже привязан другой браузер. ' + who +
        'Отвяжите его кнопкой в боте — ' +
        (r.resetsLeft > 0
          ? 'осталось ' + r.resetsLeft + ' ' + plural(r.resetsLeft, 'сброс', 'сброса', 'сбросов') + ' в этом месяце.'
          : 'сбросы в этом месяце закончились.'));
      break;
    }
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
  const btn = $('blocked-signout');
  btn.disabled = true;
  const r = await signOut();
  btn.disabled = false;
  if (r.result === 'resetLimit') {
    $('blocked-text').textContent = r.retryAfterDays
      ? `Сбросы закончились: следующий через ${r.retryAfterDays} ${plural(r.retryAfterDays, 'день', 'дня', 'дней')}. Выйти сейчас нельзя.`
      : 'Сбросы в этом месяце закончились. Выйти сейчас нельзя.';
    return;
  }
  // Выход не прошёл — вход остался в браузере. Показать форму входа значило
  // бы соврать: врач решит, что вышел, а при следующем открытии окажется
  // внутри.
  if (r.result === 'network') {
    $('blocked-text').textContent = 'Нет связи с сервером — выйти не получилось. Проверьте интернет и попробуйте ещё раз.';
    return;
  }
  // Непонятный ответ сервера по-прежнему ведёт к форме входа: это выход из
  // тупика, когда вход в браузере испорчен, — повторный вход его перезапишет.
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
// Ответы на «я открыт» приходят не по порядку: обычный сигнал, ушедший чуть
// раньше «Перенести сюда», может вернуться позже него и снова показать экран
// «открыт в другом месте». Поэтому у каждого запроса свой номер, и ответ
// старее уже учтённого отбрасывается. Смена сеанса (вход, выход) начинает
// счёт заново — запоздалый ответ прежнего сеанса не должен всплыть на экране входа.
let seatSeq = 0;
let seatApplied = 0;
let seatSession = 0;

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
  const session = seatSession;
  const mine = ++seatSeq;
  const r = await seat({ claim });
  if (session !== seatSession || mine < seatApplied) return;
  seatApplied = mine;

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
  seatSession += 1;          // ответы, ещё идущие по сети, больше не наши
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
  $('open-found-label').textContent = 'Найдено снимков';
  showOpenProgress({ dicom: 0, elapsedMs: 0 });

  // Распаковка идёт в отдельном потоке, поэтому сигнал «я открыт» продолжает
  // уходить раз в 45 секунд. Иначе долгий архив выглядел бы как простой, и
  // место отдали бы другому устройству прямо посреди работы.
  try {
    const found = await openArchive(file, {
      onProgress: showOpenProgress,
      signal: abort.signal,
    });
    openedFile = file;
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
// Файл держим до конца просмотра: второй проход читает его заново, а взять
// файл ещё раз без участия врача браузер не даёт.
let openedFile = null;

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
  // Для проверок на настоящих архивах: чем Vidi руководствовался, выбирая серию.
  window.__vidiStudy = found.study.series;
  const study = found.study;

  $('study-patient').textContent = personName(study.patientName);
  const date = studyDate(study.studyDate);
  // Служебные файлы с меткой DICOM (оглавление, проект просмотрщика) — не
  // снимки: иначе «снимков: 451» при серии из 450 выглядит потерей среза.
  const total = found.stats.dicom - (found.stats.indexFiles ?? 0);
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

  const many = (foundStudy?.study.series.length ?? 0) > 1;
  let hint = openable
    ? (many
      ? 'Открывается выбранная серия. Остальные — служебные снимки из того же архива.'
      : 'В архиве одна серия — она и откроется.')
    : 'В этом архиве нет серии, которую Vidi может открыть.';

  // Снимки, не попавшие ни в одну серию, называем вслух. Молчаливая разница
  // между «найдено 451» и «в серии 450» выглядит как потерянный срез, и врач
  // вправе знать, повтор это или файл, который не прочитался.
  const skipped = dropped(foundStudy?.stats);
  if (skipped) hint += ' ' + skipped;

  $('series-hint').textContent = hint;
}

/** Куда делись снимки, не попавшие в серии. */
function dropped(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.duplicates > 0) {
    parts.push(stats.duplicates + ' ' +
      plural(stats.duplicates, 'повтор', 'повтора', 'повторов') + ' отброшено');
  }
  const broken = (stats.unreadable ?? 0) + (stats.truncated ?? 0);
  if (broken > 0) {
    // Согласование меняется вместе с числом: «1 снимок не прочитался»,
    // «2 снимка не прочитались», «5 снимков не прочиталось».
    parts.push(broken + ' ' +
      plural(broken, 'снимок', 'снимка', 'снимков') + ' не ' +
      plural(broken, 'прочитался', 'прочитались', 'прочиталось'));
  }
  return parts.length ? parts.join(', ') + '.' : '';
}

$('study-back').addEventListener('click', () => showScreen('start'));

$('study-open').addEventListener('click', () => {
  if (chosenSeries && openedFile) runVolume(openedFile, chosenSeries);
});

/** Второй проход: собираем объём выбранной серии и показываем его. */
async function runVolume(file, series) {
  openAbort?.abort();
  openAbort = new AbortController();
  const abort = openAbort;

  showScreen('open');
  $('open-title').textContent = 'Строим объём';
  $('open-found-label').textContent = 'Срезов в объёме';
  $('open-found').textContent = '0';
  $('open-time').textContent = '0 с';
  const bar = $('open-bar');
  bar.classList.remove('is-unknown');
  bar.style.width = '0%';

  try {
    const viewer = await loadViewer();
    const built = await viewer.showVolume(file, series, {
      build: buildVolume,
      signal: abort.signal,
      onProgress: (done, total, stats) => {
        bar.style.width = Math.round(100 * done / Math.max(1, total)) + '%';
        $('open-found').textContent = done + ' из ' + total;
        $('open-time').textContent = Math.round((stats?.elapsedMs ?? 0) / 1000) + ' с';
      },
    });
    showScreen('viewer');
    V.selectPlane('axial');
    showPlate(series, built);
  } catch (e) {
    if (e instanceof ArchiveCancelled) return;
    showScreen('study');
    if (e.message === 'module-denied') {
      showError('APP-3', 'Не удалось получить доступ к просмотру. Проверьте связь и подписку.', e);
      return;
    }
    if (e instanceof ArchiveError) showError(e.code, e.text);
    else if (e.message === 'webgl') {
      showError('VOL-1', 'Браузер не смог подготовить отрисовку объёма.');
    } else if (e.message === 'too-big') {
      showError('VOL-2', 'Этот объём не помещается в память устройства даже уменьшенным.');
    } else if (e.message === 'upload') {
      showError('VOL-3', 'Видеокарта не приняла объём. Закройте другие вкладки и попробуйте снова.');
    } else if (e.message === 'lost') {
      showError('VOL-4', LOST_TEXT);
    } else {
      showError('VOL-0', 'Не удалось построить объём.', e);
    }
  } finally {
    if (openAbort === abort) openAbort = null;
  }
}

/** Ужимали ли объём под память устройства. */
function isReduced(built) {
  return built.reduction.xy > 1 || built.reduction.z > 1;
}

/*
  Сведения и имя пациента открываются круглым знаком справа. Заголовок
  просмотра остаётся Vidi Web, в том числе на снимке экрана.
*/
function showNotes(show) {
  $('notes-sheet').hidden = !show;
}

$('plate-badge').addEventListener('click', () => showNotes(true));
$('notes-close').addEventListener('click', () => showNotes(false));
$('notes-sheet').addEventListener('click', (e) => {
  if (e.target === $('notes-sheet')) showNotes(false);   // мимо карточки — закрыть
});

/*
  Знак «?» — что делают кнопки нижней панели. Подписей под значками нет (семь
  подписей в ряд на телефоне не помещаются), поэтому значок и его описание
  стоят рядом здесь. Значок копируется из самой панели: поменяли кнопку —
  подсказка поменялась вместе с ней. Кнопка без описания в подсказку не
  попадает и видна в проверке app-archive.
*/
const TOOL_HELP = {
  window: 'Яркость и контраст: ведите пальцем вправо — шире окно, вверх — светлее.',
  slab: 'Толщина панорамы: 25 → 10 → 5 → 1,5 мм. Работает, когда в четвёртой панели панорама.',
  ruler: 'Два касания — расстояние в миллиметрах.',
  angle: 'Три касания — угол, вершина во второй точке.',
  pencil: 'Рисуйте пальцем по срезу. Линия видна только на своём срезе.',
  erase: 'Убрать измерения и линии. Нажмите дважды: первое нажатие взводит кнопку.',
  reset: 'Вернуть увеличение, сдвиг, разворот и окно. Разметку не трогает.',
};

for (const btn of document.querySelectorAll('#toolbar .tool')) {
  const text = TOOL_HELP[btn.dataset.tool];
  if (!text) continue;
  const row = document.createElement('li');
  row.className = 'help-row';
  const icon = document.createElement('span');
  icon.className = 'help-ico' + (btn.classList.contains('tool-danger') ? ' is-danger' : '');
  icon.append(btn.querySelector('svg').cloneNode(true));
  const body = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = btn.querySelector('.sr-only').textContent;
  const desc = document.createElement('span');
  desc.className = 'help-text';
  desc.textContent = text;
  body.append(name, desc);
  row.append(icon, body);
  $('help-list').append(row);
}

function showHelp(show) {
  $('help-sheet').hidden = !show;
}

$('btn-help').addEventListener('click', () => showHelp(true));
$('help-close').addEventListener('click', () => showHelp(false));
$('help-x').addEventListener('click', () => showHelp(false));
$('help-sheet').addEventListener('click', (e) => {
  if (e.target === $('help-sheet')) showHelp(false);
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  showHelp(false);
  showNotes(false);
});

function showPlate(series, built) {
  $('notes-patient').textContent = personName(foundStudy?.study?.patientName);
  const size = built.geometry.mm
    ? ', точка ' + built.geometry.voxel.i.toFixed(2) + '×' +
      built.geometry.voxel.j.toFixed(2) + '×' + built.geometry.voxel.k.toFixed(2) + ' мм'
    : '';
  const head = seriesTitle(series) + ': ' + built.dims[2] + ' ' +
    plural(built.dims[2], 'срез', 'среза', 'срезов') + ', ' +
    built.dims[0] + '×' + built.dims[1] + size + '.';
  $('notes-text').textContent = [head, ...built.notes].join(' ');

  const badge = $('plate-badge');
  // Знак молчалив: размер точки и оговорки — в окне, которое он открывает.
  // Подсказка при наведении и для голосового доступа остаётся текстом.
  const short = built.geometry.mm
    ? (isReduced(built) ? 'ужат · ' + built.geometry.voxel.i.toFixed(2) + ' мм'
      : 'точка ' + built.geometry.voxel.i.toFixed(2) + ' мм')
    : 'без масштаба';
  badge.title = short;
  badge.setAttribute('aria-label', 'Сведения о пациенте и исследовании: ' + short);
  badge.dataset.short = short;
  // Жёлтым — только когда есть о чём предупредить. Постоянный жёлтый глаз
  // перестаёт замечать.
  badge.classList.toggle('is-warn', built.notes.length > 0);
  badge.hidden = false;
  showNotes(false);
}

$('open-cancel').addEventListener('click', () => {
  openAbort?.abort();
  showScreen(foundStudy ? 'study' : 'start');
});

$('btn-back').addEventListener('click', () => {
  V?.clearVolume();
  showNotes(false);
  showHelp(false);
  $('plate-badge').hidden = true;
  showScreen(foundStudy ? 'study' : 'start');
});

const LOST_TEXT = 'Браузер выгрузил снимок из памяти видеокарты — так бывает, когда вкладка ' +
  'долго в фоне. Нажмите «Открыть» ещё раз: архив выбирать заново не нужно.';

/*
  Браузер отнял у страницы видеокарту. Объём пропал вместе с ней, и
  просмотр уже сам себя очистил; здесь — сказать врачу, что случилось, и
  вернуть его туда, откуда снимок открывается одним нажатием. Файл архива и
  выбранная серия остаются, второй проход пойдёт сразу.

  Если объём в это время ещё строился, говорить будет runVolume: сборка
  закончится отказом 'lost'.
*/
function viewerLost(hadStudy) {
  if (!hadStudy || current !== 'viewer') return;
  showNotes(false);
  showHelp(false);
  $('plate-badge').hidden = true;
  showScreen(foundStudy ? 'study' : 'start');
  showError('VOL-4', LOST_TEXT);
}

// ─── Запуск ────────────────────────────────────────────────────────────────

// Только номер выпуска: по нему видно, дошло ли обновление до телефона.
// Название этапа здесь стояло со времён сборки и врачу ничего не говорило.
$('version-login').textContent = 'Vidi Web ' + VERSION;
$('version-start').textContent = 'Vidi Web ' + VERSION;
$('version-blocked').textContent = 'Vidi Web ' + VERSION;

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
