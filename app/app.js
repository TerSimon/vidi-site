//
//  Оболочка Vidi в браузере. Этап 4 — каркас: экраны, раскладка панелей,
//  проверка браузера и показ ошибок. Ни DICOM, ни архивов здесь ещё нет.
//
//  Два правила действуют с самого начала, чтобы позже их не пришлось вносить
//  через весь код:
//  • наружу не уходит ничего — ни имён файлов, ни данных пациента, ни отчётов
//    об ошибках. На экране только код ошибки, который врач называет вслух;
//  • в браузере ничего не хранится: ни localStorage, ни кеша исследований.
//

const VERSION = '0.1.0';
const STAGE = 'каркас';

// ─── Ошибки ────────────────────────────────────────────────────────────────

const errorSheet = document.getElementById('error-sheet');
const errorText = document.getElementById('error-text');
const errorCode = document.getElementById('error-code');

/**
 * Показывает ошибку врачу. `code` — короткая метка для разговора с поддержкой,
 * `text` — что делать. Подробности остаются в консоли и никуда не отправляются.
 */
function showError(code, text, detail) {
  errorCode.textContent = code;
  errorText.textContent = text;
  errorSheet.hidden = false;
  if (detail) console.error(`[${code}]`, detail);
}

document.getElementById('error-close').addEventListener('click', () => {
  errorSheet.hidden = true;
});

// Необработанный сбой не должен выглядеть как «приложение зависло».
window.addEventListener('error', (e) => {
  showError('APP-1', 'Что-то пошло не так. Перезагрузите страницу.', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  showError('APP-2', 'Что-то пошло не так. Перезагрузите страницу.', e.reason);
});

// ─── Экраны ────────────────────────────────────────────────────────────────

const screens = {
  start: document.getElementById('screen-start'),
  viewer: document.getElementById('screen-viewer'),
};

function showScreen(name) {
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

  return { rows, blocking };
}

function renderEnvironment() {
  const { rows, blocking } = checkEnvironment();
  const dl = document.getElementById('env-rows');
  dl.textContent = '';

  for (const [label, ok, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value ?? (ok ? 'есть' : 'нет');
    dd.className = ok ? 'ok' : 'bad';
    dl.append(dt, dd);
  }

  const hint = document.getElementById('env-hint');
  const openBtn = document.getElementById('btn-open');

  if (blocking) {
    hint.textContent = 'Этот браузер не сможет открыть КТ. Обновите его или откройте Vidi в Safari либо Chrome. Код ' + blocking + '.';
    hint.hidden = false;
    openBtn.disabled = true;
    document.getElementById('open-hint').textContent = 'Открытие недоступно в этом браузере.';
  } else {
    hint.hidden = true;
  }
}

// ─── Панели ────────────────────────────────────────────────────────────────

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

// ─── Запуск ────────────────────────────────────────────────────────────────

const versionLabel = VERSION + ' · ' + STAGE;
document.getElementById('version-start').textContent = 'Vidi ' + versionLabel;
document.getElementById('version-viewer').textContent = versionLabel;

renderEnvironment();

document.getElementById('btn-open').addEventListener('click', () => {
  showScreen('viewer');
  const plate = document.getElementById('plate');
  plate.textContent = 'Каркас без снимка. Открытие архива и просмотр появятся на следующих этапах.';
  plate.hidden = false;
});

document.getElementById('btn-back').addEventListener('click', () => showScreen('start'));

showScreen('start');
