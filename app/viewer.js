//
//  Просмотр объёма: три плоскости, окно, линейка, угол.
//
//  Панели рисует WebGL (render/mpr.js), поверх — обычный canvas с перекрестием
//  и разметкой. Всё, что показывается в миллиметрах, считается через геометрию
//  серии (geometry.js) и раскладку сторон (planes.js) — здесь только рука
//  врача и то, что он видит.
//
//  Измерения хранятся в точках объёма, а не в пикселях экрана: зум, поворот
//  телефона и уменьшение объёма под память их не сдвигают.
//

import { buildGeometry, distanceMM, angleDeg, reduced } from './geometry.js?v=0.4.3';
import { PLANES, planeLayout, screenMap, screenToVoxel, voxelToScreen } from './planes.js?v=0.4.3';
import { MPRRenderer, chooseReduction, memoryBudget } from './render/mpr.js?v=0.4.3';
import { buildVolume } from './archive.js?v=0.4.3';

const $ = (id) => document.getElementById(id);

const panes = new Map();       // plane → { el, canvas, ctx, empty, marks }
let renderer = null;
let study = null;              // { geometry, layouts, dims, look, reduction, notes }
let crosshair = null;          // точка объёма, общая для всех панелей
let view = null;               // plane → { zoom, panU, panV }
let tool = 'navigate';
let measures = [];             // { plane, kind, points: [[i,j,k], …] }
let pending = null;            // незаконченное измерение

// ─── Подключение к странице ────────────────────────────────────────────────

export function attachViewer() {
  for (const el of document.querySelectorAll('.pane')) {
    const plane = el.dataset.plane;
    const canvas = el.querySelector('.pane-canvas');
    panes.set(plane, {
      el, canvas,
      ctx: canvas.getContext('2d'),
      empty: el.querySelector('.pane-empty'),
      name: el.querySelector('.pane-name'),
      markL: el.querySelector('.mark-l'),
      markR: el.querySelector('.mark-r'),
    });
    if (plane !== 'volume') bindPointer(plane);
  }

  for (const tab of document.querySelectorAll('.plane-tab')) {
    tab.addEventListener('click', () => selectPlane(tab.dataset.plane));
  }
  for (const btn of document.querySelectorAll('.tool')) {
    btn.addEventListener('click', () => useTool(btn.dataset.tool));
  }

  const relayout = () => { layoutPanes(); drawAll(); };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(relayout);
    for (const p of panes.values()) ro.observe(p.el);
  }
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 200));
  layoutPanes();
  drawAll();
}

/**
 * Пересчитать размеры панелей и перерисовать. Нужно после показа экрана
 * просмотра: у скрытого элемента размеров нет, и canvas посчитался бы в ноль.
 */
export function layoutViewer() {
  layoutPanes();
  drawAll();
}

export function selectPlane(plane) {
  for (const [name, p] of panes) p.el.classList.toggle('is-active', name === plane);
  for (const tab of document.querySelectorAll('.plane-tab')) {
    const on = tab.dataset.plane === plane;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  layoutPanes();
  drawAll();
}

/**
 * Размер canvas в точках устройства. Плотность режем до 2: третий пиксель на
 * телефоне не виден, а работы на кадр прибавляет в полтора раза.
 */
function layoutPanes() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const p of panes.values()) {
    if (p.el.offsetParent === null) continue;
    const w = Math.max(1, Math.round(p.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(p.canvas.clientHeight * dpr));
    if (p.canvas.width !== w || p.canvas.height !== h) {
      p.canvas.width = w;
      p.canvas.height = h;
    }
  }
}

// ─── Открытие объёма ───────────────────────────────────────────────────────

/**
 * Собирает объём выбранной серии и показывает его.
 * `onProgress(done, total)` — сколько срезов уже легло.
 */
export async function showVolume(file, series, { onProgress, signal } = {}) {
  const geometry = buildGeometry(series, series.plan);

  // Уменьшать приходится не всегда, но решать надо ДО второго прохода: он
  // длится минуты, и узнать на его исходе, что объём не влез, значит потратить
  // их впустую.
  if (!renderer) renderer = MPRRenderer.create();
  if (!renderer || renderer.broken) throw new Error('webgl');
  const gl = renderer.gl;
  const shape = chooseReduction(gl, series.columns, series.rows, geometry.order.length,
    memoryBudget());
  if (!shape) throw new Error('too-big');

  const volume = await buildVolume(file, {
    seriesUID: series.uid,
    columns: series.columns,
    rows: series.rows,
    slices: geometry.order.length,
    stepXY: shape.stepXY,
    stepZ: shape.stepZ,
    order: geometry.order.map((s) => s.key),
  }, {
    onProgress: (stats, fill) => onProgress?.(fill?.filled ?? 0, fill?.total ?? shape.d, stats),
    signal,
  });

  if (!renderer.upload(volume)) throw new Error('upload');

  const g = reduced(geometry, shape.stepXY, shape.stepZ);
  const dims = [volume.w, volume.h, volume.d];
  const layouts = {};
  for (const plane of PLANES) layouts[plane] = planeLayout(g, plane);

  study = {
    geometry: g,
    layouts,
    dims,
    series,
    reduction: { xy: shape.stepXY, z: shape.stepZ },
    missing: volume.missing,
    histogram: volume.histogram,
    look: autoWindow(volume.histogram, series),
    notes: notes(g, shape, volume),
  };
  crosshair = dims.map((n) => (n - 1) / 2);
  view = {};
  for (const plane of PLANES) view[plane] = { zoom: 1, panU: 0, panV: 0 };
  measures = [];
  pending = null;
  tool = 'navigate';
  updateTools();
  applyMarks();
  layoutPanes();
  drawAll();
  return study;
}

/** Убирает объём с экрана и освобождает память видеокарты. */
export function clearVolume() {
  study = null;
  crosshair = null;
  measures = [];
  pending = null;
  renderer?.dispose();
  for (const p of panes.values()) {
    p.empty.hidden = false;
    p.ctx?.clearRect(0, 0, p.canvas.width, p.canvas.height);
  }
  updateTools();
}

/**
 * Что сказать врачу про этот объём вслух. Молчать здесь нельзя: и уменьшение,
 * и недостающие срезы, и отсутствие геометрии меняют то, чему можно верить.
 */
function notes(g, shape, volume) {
  const out = [];
  if (!g.mm) out.push(g.reason);
  if (shape.stepXY > 1 || shape.stepZ > 1) {
    // Размер точки уже назван строкой выше — здесь важно другое: что объём
    // ужали и чем это отзовётся на прицеливании.
    const slices = shape.stepZ > 1
      ? ' Взят каждый ' + (shape.stepZ === 2 ? 'второй' : shape.stepZ + '-й') + ' срез.'
      : ' Все срезы на месте.';
    out.push('Объём уменьшен под память устройства.' + slices +
      ' Измерения остаются точными, но мельче точки не прицелиться.');
  }
  if (volume.missing > 0) {
    out.push(volume.missing + ' ' +
      (volume.missing === 1 ? 'срез не лёг' : 'срезов не легло') + ' в объём.');
  }
  return out;
}

/**
 * Окно по гистограмме объёма. Считать его по крайним значениям нельзя: одна
 * металлическая пломба растянет размах на весь экран и кость станет серой.
 */
function autoWindow(histogram, series) {
  const slope = Number.isFinite(series.slope) ? series.slope : 1;
  const intercept = Number.isFinite(series.intercept) ? series.intercept : 0;
  let total = 0;
  for (const n of histogram) total += n;
  if (!total) return { center: 400, width: 2000, slope, intercept, signed: !!series.signed, invert: !!series.monochrome1 };

  const at = (fraction) => {
    let seen = 0;
    const target = total * fraction;
    for (let bin = 0; bin < histogram.length; bin++) {
      seen += histogram[bin];
      if (seen >= target) return ((bin << 4) - 32768) * slope + intercept;
    }
    return 0;
  };
  const lo = at(0.02);
  const hi = at(0.995);
  const width = Math.max(500, hi - lo);
  return {
    center: lo + width / 2,
    width,
    slope, intercept,
    signed: !!series.signed,
    invert: !!series.monochrome1,
  };
}

// ─── Отрисовка ─────────────────────────────────────────────────────────────

function mapFor(plane) {
  const p = panes.get(plane);
  return screenMap(study.geometry, study.layouts[plane], study.dims,
    p.canvas.width, p.canvas.height,
    { ...view[plane], index: crosshair[study.layouts[plane].n] });
}

function drawAll() {
  for (const plane of PLANES) drawPane(plane);
  drawVolumePane();
}

function drawPane(plane) {
  const p = panes.get(plane);
  if (!p || p.el.offsetParent === null) return;
  const ctx = p.ctx;
  if (!ctx) return;

  if (!study) {
    p.empty.hidden = false;
    drawGrid(ctx, p.canvas);
    return;
  }
  p.empty.hidden = true;

  const map = mapFor(plane);
  const image = renderer.render(p.canvas.width, p.canvas.height, map, study.look);
  if (image) ctx.drawImage(image, 0, 0);
  else drawGrid(ctx, p.canvas);

  drawCrosshair(ctx, p.canvas, plane, map);
  drawMeasures(ctx, plane, map);
  drawScale(ctx, p.canvas, map);
}

/** Третья панель пока без объёмной картинки — она на следующем этапе. */
function drawVolumePane() {
  const p = panes.get('volume');
  if (!p || p.el.offsetParent === null || !p.ctx) return;
  p.empty.hidden = !!study;
  drawGrid(p.ctx, p.canvas);
}

function drawGrid(ctx, canvas) {
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const step = Math.max(24, Math.round(Math.min(w, h) / 8));
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
  ctx.stroke();
}

function drawCrosshair(ctx, canvas, plane, map) {
  const layout = study.layouts[plane];
  const [x, y] = voxelToScreen(map, layout, crosshair);
  ctx.strokeStyle = 'rgba(79,156,255,0.55)';
  ctx.lineWidth = 1;
  const gap = 10;
  ctx.beginPath();
  ctx.moveTo(x, 0); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, canvas.height);
  ctx.moveTo(0, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(canvas.width, y);
  ctx.stroke();
}

/** Масштабная полоска: сколько это миллиметров, видно не считая в уме. */
function drawScale(ctx, canvas, map) {
  if (!study.geometry.mm) return;
  const targetPx = Math.min(canvas.width * 0.25, 160);
  const mm = niceLength(targetPx * map.mmPerPixel);
  const px = mm / map.mmPerPixel;
  const x = 14;
  const y = canvas.height - 18;
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
  ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
  ctx.stroke();
  label(ctx, x + px / 2, y - 8, mm + ' мм', 'center');
}

function niceLength(mm) {
  const steps = [1, 2, 5, 10, 20, 50, 100];
  for (const s of steps) if (mm <= s) return s;
  return 100;
}

function drawMeasures(ctx, plane, map) {
  const layout = study.layouts[plane];
  const all = pending && pending.plane === plane ? [...measures, pending] : measures;
  for (const m of all) {
    if (m.plane !== plane) continue;
    // Разметка видна на своём срезе и рядом с ним: иначе она легла бы поверх
    // другой анатомии и выглядела бы как измерение этой.
    const off = Math.abs(m.points[0][layout.n] - crosshair[layout.n]);
    if (off > 2) continue;
    const fade = Math.max(0.25, 1 - off / 2);
    const pts = m.points.map((v) => voxelToScreen(map, layout, v));

    ctx.strokeStyle = `rgba(255,196,0,${fade})`;
    ctx.fillStyle = `rgba(255,196,0,${fade})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const text = measureText(m);
    if (text) {
      const [x, y] = pts[pts.length - 1];
      label(ctx, x + 10, y - 10, text, 'left', fade);
    }
  }
}

/** Что показать рядом с разметкой. Без геометрии — ничего, кроме отказа. */
function measureText(m) {
  if (!study.geometry.mm) return 'без масштаба';
  if (m.kind === 'ruler' && m.points.length === 2) {
    return distanceMM(study.geometry, m.points[0], m.points[1]).toFixed(1) + ' мм';
  }
  if (m.kind === 'angle' && m.points.length === 3) {
    const a = angleDeg(study.geometry, m.points[0], m.points[1], m.points[2]);
    return a === null ? '' : a.toFixed(1) + '°';
  }
  return '';
}

function label(ctx, x, y, text, align, alpha = 1) {
  ctx.font = '600 15px -apple-system, system-ui, sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(0,0,0,${0.75 * alpha})`;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.fillText(text, x, y);
}

/** Буквы сторон. Нет направлений осей — нет и букв. */
function applyMarks() {
  for (const plane of PLANES) {
    const p = panes.get(plane);
    const layout = study?.layouts[plane];
    if (!p) continue;
    if (!layout || !layout.trusted) {
      p.markL.hidden = true;
      p.markR.hidden = true;
      if (layout) p.name.textContent = layout.name + ' · стороны не определены';
      continue;
    }
    p.markL.hidden = false;
    p.markR.hidden = false;
    p.markL.textContent = layout.left;
    p.markR.textContent = layout.right;
    p.name.textContent = layout.name;
  }
}

// ─── Инструменты ───────────────────────────────────────────────────────────

function updateTools() {
  for (const btn of document.querySelectorAll('.tool')) {
    const name = btn.dataset.tool;
    const usable = !!study && (name !== 'slab');
    btn.disabled = !usable;
    btn.classList.toggle('is-active', usable && tool === name);
  }
}

function useTool(name) {
  if (!study) return;
  if (name === 'reset') { resetView(); return; }
  tool = tool === name ? 'navigate' : name;
  pending = null;
  updateTools();
  drawAll();
}

function resetView() {
  for (const plane of PLANES) view[plane] = { zoom: 1, panU: 0, panV: 0 };
  crosshair = study.dims.map((n) => (n - 1) / 2);
  study.look = autoWindow(study.histogram, study.series);
  pending = null;
  drawAll();
}

/** Убрать всю разметку. Отдельно от сброса вида: это разные действия. */
export function clearMeasures() {
  measures = [];
  pending = null;
  drawAll();
}

// ─── Рука врача ────────────────────────────────────────────────────────────

const MOVE_THRESHOLD = 6;      // меньше — это касание, а не движение

function bindPointer(plane) {
  const p = panes.get(plane);
  const canvas = p.canvas;
  const points = new Map();
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!study) return;
    canvas.setPointerCapture(e.pointerId);
    points.set(e.pointerId, pos(canvas, e));
    if (points.size === 1) {
      drag = { start: pos(canvas, e), moved: false, index: crosshair[study.layouts[plane].n],
        look: { ...study.look }, pan: { ...view[plane] } };
    } else if (points.size === 2) {
      const [a, b] = [...points.values()];
      drag = {
        pinch: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        zoom: view[plane].zoom,
        pan: { panU: view[plane].panU, panV: view[plane].panV },
        moved: true,
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!study || !points.has(e.pointerId)) return;
    points.set(e.pointerId, pos(canvas, e));

    if (points.size >= 2 && drag?.pinch) {
      const [a, b] = [...points.values()];
      const now = Math.hypot(a.x - b.x, a.y - b.y);
      if (drag.pinch > 4) {
        view[plane].zoom = Math.min(8, Math.max(1, drag.zoom * now / drag.pinch));
      }
      // Сдвиг середины между пальцами двигает снимок. В миллиметрах, а не в
      // точках: иначе на уменьшенном объёме рука ехала бы вдвое быстрее.
      const map = mapFor(plane);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view[plane].panU = drag.pan.panU - (mid.x - drag.mid.x) * map.mmPerPixel *
        (study.layouts[plane].u.flip ? -1 : 1);
      view[plane].panV = drag.pan.panV - (mid.y - drag.mid.y) * map.mmPerPixel *
        (study.layouts[plane].v.flip ? -1 : 1);
      drawPane(plane);
      return;
    }
    if (!drag || drag.pinch) return;

    const here = pos(canvas, e);
    const dx = here.x - drag.start.x;
    const dy = here.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    drag.moved = true;

    if (tool === 'window') {
      // Как принято в просмотрщиках: вправо — шире окно, вверх — светлее.
      study.look = {
        ...study.look,
        width: Math.max(50, drag.look.width + dx * 4),
        center: drag.look.center - dy * 4,
      };
      drawAll();
      return;
    }
    // Движение листает срезы в любом инструменте: запрет листать, пока
    // выбрана линейка, ломает работу — на Mac это уже проходили.
    // Полное движение по панели сверху вниз — весь объём.
    const layout = study.layouts[plane];
    const perPixel = study.dims[layout.n] / Math.max(1, canvas.height * 0.9);
    setIndex(layout.n, drag.index + dy * perPixel);
    drawAll();
  });

  const end = (e) => {
    if (!study) return;
    const wasDrag = drag;
    points.delete(e.pointerId);
    if (points.size === 0) drag = null;
    if (!wasDrag || wasDrag.moved || wasDrag.pinch) return;
    tap(plane, pos(canvas, e));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => { points.delete(e.pointerId); drag = null; });
}

function pos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / Math.max(1, rect.width);
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
}

function setIndex(axis, value) {
  crosshair[axis] = Math.min(study.dims[axis] - 1, Math.max(0, value));
}

function tap(plane, at) {
  const map = mapFor(plane);
  const voxel = screenToVoxel(map, at.x, at.y);
  if (voxel.some((v, a) => v < -0.5 || v > study.dims[a] - 0.5)) return;

  if (tool === 'ruler' || tool === 'angle') {
    const need = tool === 'ruler' ? 2 : 3;
    if (!pending || pending.kind !== tool || pending.plane !== plane) {
      pending = { plane, kind: tool, points: [voxel] };
    } else {
      pending.points.push(voxel);
      if (pending.points.length >= need) {
        measures.push(pending);
        pending = null;
      }
    }
    drawPane(plane);
    return;
  }

  // Обычное касание переносит перекрестие: остальные панели показывают тот же
  // самый уровень, а не свой собственный.
  crosshair = voxel.map((v, a) => Math.min(study.dims[a] - 1, Math.max(0, v)));
  drawAll();
}

/** Для проверок: что сейчас на экране. */
export function viewerState() {
  if (!study) return null;
  return {
    dims: study.dims,
    reduction: study.reduction,
    mm: study.geometry.mm,
    voxel: study.geometry.voxel,
    notes: study.notes,
    crosshair: crosshair.slice(),
    measures: measures.map((m) => ({ kind: m.kind, plane: m.plane, text: measureText(m) })),
    window: { center: study.look.center, width: study.look.width },
  };
}

/** Для проверок: точка объёма → точка экрана на этой панели. */
export function toScreen(plane, voxel) {
  if (!study) return null;
  return voxelToScreen(mapFor(plane), study.layouts[plane], voxel);
}

/** Для проверок: увеличение панели, как после щипка пальцами. */
export function setZoom(plane, zoom) {
  if (!study) return;
  view[plane].zoom = Math.min(8, Math.max(1, zoom));
  drawPane(plane);
}

/** Для проверок: преобразование экрана и объёма для одной панели. */
export function paneMap(plane) {
  if (!study) return null;
  return { map: mapFor(plane), layout: study.layouts[plane] };
}

/** Для проверок: поставить измерение по экранным точкам. */
export function measureAt(plane, points, kind = 'ruler') {
  const map = mapFor(plane);
  const m = { plane, kind, points: points.map(([x, y]) => screenToVoxel(map, x, y)) };
  measures.push(m);
  drawPane(plane);
  return measureText(m);
}

// Опоры для автоматических проверок.
//
// Через import их не взять: у './viewer.js?v=0.4.3' и './viewer.js?v=0.4.3'
// разные экземпляры модуля, и проверка получила бы пустой просмотр вместо
// открытого. Номер в адресе меняется каждый выпуск, поэтому проверки
// цепляются сюда, а не за адрес. Внутренности приложения в браузере и так
// открыты — тайны тут нет.
globalThis.__vidiViewer = {
  state: viewerState, paneMap, toScreen, measureAt, setZoom, selectPlane, clearMeasures,
};
