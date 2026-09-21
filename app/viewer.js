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

import { buildGeometry, distanceMM, angleDeg, reduced } from './geometry.js?v=0.7.0';
import { PLANES, planeLayout, screenMap, screenToVoxel, voxelToScreen, zoomAround,
  planeBasis, noRotation, rotateAround } from './planes.js?v=0.7.0';
import { MPRRenderer, chooseReduction, memoryBudget } from './render/mpr.js?v=0.7.0';
import { buildVolume } from './archive.js?v=0.7.0';
import { PanoRenderer } from './render/pano.js?v=0.7.0';
import { VolumeRenderer, halfView } from './render/volume3d.js?v=0.7.0';
import { fitArch, defaultArch, sampledColumns, archLength } from './arch.js?v=0.7.0';
import { patientAxes } from './geometry.js?v=0.7.0';

const $ = (id) => document.getElementById(id);

const panes = new Map();       // plane → { el, canvas, ctx, empty, marks }
let renderer = null;
let pano = null;                // развёртка вдоль дуги
let volume3d = null;            // объёмный вид
let fourth = 'volume';          // что в четвёртой панели
let panoView = null;            // увеличение и сдвиг развёртки
let archReason = '';            // почему развёртки нет
let study = null;              // { geometry, layouts, dims, look, reduction, notes }
let crosshair = null;          // точка объёма, общая для всех панелей
let view = null;               // plane → { zoom, panU, panV }
let tool = 'navigate';
// Разворот каркаса: все три панели поворачиваются вместе. Нужен, чтобы вести
// срез вдоль оси зуба, а не вдоль осей аппарата — ради этого косой срез и
// существует. До этого этапа его в браузере не было вовсе.
let rotation = noRotation();
let rotating = null;           // в какой панели сейчас держат ручку разворота
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
      chip: el.querySelector('.plane-chip'),
      chipName: el.querySelector('.chip-name'),
      chipValue: el.querySelector('.chip-value'),
      chipUnit: el.querySelector('.unit'),
      markL: el.querySelector('.mark-l'),
      markR: el.querySelector('.mark-r'),
    });
    if (plane !== 'volume') bindPointer(plane); else bindVolumePointer();
  }

  for (const tab of document.querySelectorAll('.plane-tab')) {
    tab.addEventListener('click', () => selectPlane(tab.dataset.plane));
  }
  for (const btn of document.querySelectorAll('.tool')) {
    btn.addEventListener('click', () => useTool(btn.dataset.tool));
  }
  document.getElementById('btn-pano')?.addEventListener('click', () => {
    setFourth(fourth === 'panorama' ? 'volume' : 'panorama');
  });
  for (const btn of document.querySelectorAll('.view-btn')) {
    btn.addEventListener('click', () => applyViewPreset(btn.dataset.view));
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
  if (!pano) pano = new PanoRenderer(gl);
  if (!volume3d) volume3d = new VolumeRenderer(gl);
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

  // Анатомическое пространство: какая ось объёма идёт вправо пациента, какая
  // назад, какая вниз. Объёмный вид и развёртка живут в нём, а не в осях
  // файла — иначе сагиттально записанный снимок встал бы на бок.
  const ax = layouts.axial;
  const letters = g.mm ? patientAxes(g) : null;
  const axisLetter = [letters?.i, letters?.j, letters?.k];
  const vox = [g.voxel.i, g.voxel.j, g.voxel.k];
  const space = {
    axes: { u: ax.u.axis, v: ax.v.axis, n: ax.n },
    flip: {
      u: ax.u.flip,
      v: ax.v.flip,
      // Высота считается сверху вниз: если номер среза растёт к макушке,
      // порядок переворачиваем, иначе голова окажется внизу.
      n: axisLetter[ax.n] === 'S',
    },
    voxel: { u: vox[ax.u.axis], v: vox[ax.v.axis], n: vox[ax.n] },
    sizeMM: {
      u: dims[ax.u.axis] * vox[ax.u.axis],
      v: dims[ax.v.axis] * vox[ax.v.axis],
      n: dims[ax.n] * vox[ax.n],
    },
    signed: !!series.signed,
    slope: Number.isFinite(series.slope) ? series.slope : 1,
    intercept: Number.isFinite(series.intercept) ? series.intercept : 0,
  };

  study = {
    geometry: g,
    layouts,
    space,
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
  // Порог кости подбирается от окна: у конусно-лучевых снимков шкала плавает,
  // и постоянные 300 HU на одном аппарате дают череп, на другом — туман.
  view.volume = {
    yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, moving: false,
    threshold: null, softness: null,
  };
  resetVolumeLook();
  updateTools();
  measures = [];
  pending = null;
  tool = 'navigate';
  study.arch = prepareArch();
  rotation = noRotation();
  rotating = null;
  panoView = { zoom: 1, panX: 0, panY: 0 };
  fourth = 'volume';
  updateFourthButton();
  updateTools();
  applyMarks();
  layoutPanes();
  drawAll();
  return study;
}

/**
 * Подбирает дугу по самому снимку и готовит колонки развёртки.
 *
 * Проекция считается на видеокарте и возвращается обратно упакованной: держать
 * копию объёма в памяти ради дуги нельзя. Развороты сторон применяются здесь —
 * дальше дуга живёт в координатах аксиального вида, где вправо это левая
 * сторона пациента, а вниз — затылок.
 */
function prepareArch() {
  if (!study.geometry.mm) return fail('без размера точки дугу не построить');
  if (!pano || pano.broken) return fail('браузер не собрал расчёт развёртки');
  const { space, dims } = study;
  const raw = pano.axialMIP(renderer.texture, dims, space.axes, space.signed);
  if (!raw) return fail('видеокарта не дала посчитать проекцию');

  const { width, height } = raw;
  const image = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = space.flip.v ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const sx = space.flip.u ? width - 1 - x : x;
      image[y * width + x] = raw.data[sy * width + sx];
    }
  }

  const size = { u: space.sizeMM.u, v: space.sizeMM.v };
  const control = fitArch({ data: image, width, height }, size,
    { slope: space.slope, intercept: space.intercept });

  // Шаг развёртки — самая мелкая точка объёма: мельче неё подробностей нет,
  // крупнее — теряем то, что есть.
  const pixelMM = Math.max(0.12, Math.min(space.voxel.u, space.voxel.v, space.voxel.n));
  const columns = sampledColumns(control, pixelMM);
  if (!columns.points.length) return fail('дуга вышла вырожденной');
  if (!pano.setColumns(columns.points, columns.normals)) return fail('колонки не легли в память видеокарты');

  archReason = '';
  return { control, pixelMM, lengthMM: columns.lengthMM, columns, slabMM: SLAB_STEPS[0] };
}

/** Почему развёртки не будет. Молчаливо выключенная кнопка — это загадка. */
function fail(reason) {
  archReason = reason;
  console.warn('[панорама] ' + reason);
  return null;
}

/** Убирает объём с экрана и освобождает память видеокарты. */
export function clearVolume() {
  study = null;
  crosshair = null;
  measures = [];
  pending = null;
  fourth = 'volume';
  panoView = null;
  pano?.dispose();
  renderer?.dispose();
  updateFourthButton();
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
  const layout = study.layouts[plane];
  return screenMap(study.geometry, layout, study.dims,
    p.canvas.width, p.canvas.height,
    { ...view[plane], basis: planeBasis(layout, rotation), center: crosshair });
}

function drawAll() {
  for (const plane of PLANES) drawPane(plane);
  drawVolumePane();
  updateChips();   // значение в чипе идёт за срезом
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
  drawLook(ctx, p.canvas);
}

/*
  Окно на снимке. На Mac ширина и центр написаны прямо в тулбаре, и врач по ним
  понимает, почему кость выглядит так, а не иначе. В браузере тулбар узкий,
  поэтому значения стоят в углу самого снимка — там же, где на Mac линейка
  масштаба и подпись слоя развёртки.
*/
function drawLook(ctx, canvas) {
  if (!study?.look) return;
  label(ctx, canvas.width - 14, canvas.height - 14,
    'окно ' + Math.round(study.look.width) + ' · центр ' + Math.round(study.look.center),
    'right', 0.8);
}

/** Четвёртая панель: объёмный вид или развёртка вдоль дуги. */
function drawVolumePane() {
  const p = panes.get('volume');
  if (!p || p.el.offsetParent === null || !p.ctx) return;
  const ctx = p.ctx;
  if (!study) {
    p.empty.hidden = false;
    drawGrid(ctx, p.canvas);
    return;
  }
  p.empty.hidden = true;
  ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  if (fourth === 'panorama' && study.arch) drawPanorama(p, ctx);
  else drawVolume3D(p, ctx);
  updateViewButtons();
}

function drawPanorama(p, ctx) {
  const a = study.arch;
  const slab = a.slabMM;
  // Развёртка берёт максимум по толщине слоя, поэтому она ярче обычного среза
  // на всю толщину. Окно, подобранное по срезам, пересвечивает её: сдвигаем
  // его вверх тем сильнее, чем толще слой.
  const lift = Math.min(0.35, 0.02 * slab);
  const look = { ...study.look, center: study.look.center + study.look.width * lift };
  const size = pano.render(renderer.canvas, renderer.texture, study.dims, {
    axes: study.space.axes,
    flip: study.space.flip,
    voxel: study.space.voxel,
    heightMM: study.space.sizeMM.n,
    pixelMM: a.pixelMM,
    slabMM: slab,
    slabStepMM: Math.max(0.15, Math.min(study.space.voxel.u, study.space.voxel.v)),
  }, look);
  if (!size) { drawGrid(ctx, p.canvas); return; }

  // Вписываем целиком, потом применяем увеличение и сдвиг. Сдвиг ограничен
  // так, чтобы картинку нельзя было утащить за край и потерять.
  const fit = Math.min(p.canvas.width / size.width, p.canvas.height / size.height);
  // Развёртка втрое шире, чем выше. На телефоне в портрете она вписывается по
  // ширине и занимает пятую часть экрана — полоска, на которой зуб размером с
  // букву. Там даём ей заполнить высоту, но не больше чем в 2,5 раза от
  // вписанного: дальше из кадра уходит половина ряда, и врач перестаёт
  // понимать, к какой стороне относится то, что он видит.
  // На широкой панели (два на два, телефон боком) поведение прежнее: видна
  // вся дуга целиком.
  const portrait = p.canvas.height > p.canvas.width;
  const base = portrait ? Math.min(p.canvas.height / size.height, fit * 2.5) : fit;
  const scale = base * panoView.zoom;
  const w = size.width * scale;
  const h = size.height * scale;
  const limitX = Math.max(0, (w - p.canvas.width) / 2);
  const limitY = Math.max(0, (h - p.canvas.height) / 2);
  panoView.panX = Math.max(-limitX, Math.min(limitX, panoView.panX));
  panoView.panY = Math.max(-limitY, Math.min(limitY, panoView.panY));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(renderer.canvas,
    (p.canvas.width - w) / 2 + panoView.panX,
    (p.canvas.height - h) / 2 + panoView.panY, w, h);
  // base, а не fit: щипок должен считать от того масштаба, который на экране.
  // fit остаётся рядом только для проверок — отсюда видно, насколько развёртку
  // подняли над вписанной в панель.
  panoView.last = { base, fit, width: size.width, height: size.height,
    canvasW: p.canvas.width, canvasH: p.canvas.height };

  label(ctx, p.canvas.width - 14, 26,
    'слой ' + (slab < 10 ? slab.toFixed(1) : Math.round(slab)) + ' мм' +
    (panoView.zoom > 1.05 ? ' · ×' + panoView.zoom.toFixed(1) : ''), 'right', 0.85);
}

function drawVolume3D(p, ctx) {
  const v = view.volume;
  const finest = Math.min(study.space.voxel.u, study.space.voxel.v, study.space.voxel.n);
  // Шаг луча один и тот же, крутят объём или нет. Грубый шаг при вращении
  // казался разумной экономией, но кость толщиной в пару точек он проскакивает
  // — у соседних лучей выходит разный ответ, и это видно как рябь. Экономим
  // размером расчёта, а не шагом: лишние точки экрана глазу незаметны,
  // пропущенная кость — заметна.
  const step = Math.max(0.45, finest * 1.5);
  // Объём считается лучами, и цена кадра — это число точек экрана. Плотность
  // экрана телефона тут не помощник: на объёмной картинке лишние пиксели не
  // видны, а работы прибавляют вчетверо. Поэтому считаем в ограниченном
  // размере и растягиваем.
  // При вращении считаем мельче, но не настолько, чтобы зерно вырастало
  // вдвое при растягивании на экран.
  const cap = v.moving ? 512 : 640;
  const longest = Math.max(p.canvas.width, p.canvas.height);
  const scale = Math.min(1, cap / longest);
  const w = Math.max(1, Math.round(p.canvas.width * scale));
  const h = Math.max(1, Math.round(p.canvas.height * scale));
  if (renderer.canvas.width !== w || renderer.canvas.height !== h) {
    renderer.canvas.width = w;
    renderer.canvas.height = h;
  }
  const size = volume3d.render(renderer.canvas, renderer.texture, study.dims, {
    axes: study.space.axes,
    flip: study.space.flip,
    voxel: study.space.voxel,
    sizeMM: study.space.sizeMM,
    signed: study.space.signed,
    slope: study.space.slope,
    intercept: study.space.intercept,
  }, {
    yaw: v.yaw, pitch: v.pitch, zoom: v.zoom,
    panX: v.panX, panY: v.panY,
    stepMM: step,
    gradMM: Math.max(0.35, finest),
    threshold: v.threshold,
    softness: v.softness,
  });
  if (!size) { drawGrid(ctx, p.canvas); return; }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(renderer.canvas, 0, 0, p.canvas.width, p.canvas.height);
}

/** Кнопка переключения четвёртой панели. */
function updateFourthButton() {
  const btn = document.getElementById('btn-pano');
  if (!btn) return;
  const canPano = !!study?.arch;
  btn.disabled = !canPano;
  btn.title = canPano ? '' : (archReason || 'развёртка недоступна');
  btn.textContent = fourth === 'panorama' ? '3D' : 'Панорама';
  const name = panes.get('volume')?.chipName;
  if (name) name.textContent = fourth === 'panorama' ? 'Pano' : '3D';
  updateViewButtons();
}

export function setFourth(mode) {
  if (!study) return;
  if (mode === 'panorama' && !study.arch) return;
  fourth = mode;
  updateFourthButton();
  updateTools();
  drawVolumePane();
}

/*
  Готовые ракурсы. Пальцем можно повернуть череп куда угодно, а вернуться к
  прямому виду — нет: промах в пару градусов заметен, и врач крутит его
  туда-сюда. На Mac ровно для этого есть пресеты камеры.

  Нули — это вид спереди: базис в volume3d.js задан как «вправо +u, вверх −n,
  луч +v», то есть при yaw=0 и pitch=0 камера уже смотрит в лицо.
*/
const VIEW_PRESETS = {
  front: { yaw: 0, pitch: 0 },
  side: { yaw: Math.PI / 2, pitch: 0 },
  // Не 1.4: там стоит ограничитель поворота, и вид упирался бы в край.
  top: { yaw: 0, pitch: 1.2 },
};

let viewAnim = null;

/** Разница углов по короткой дуге: с 350° к 10° — это 20°, а не 340°. */
function angleDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Переход к ракурсу. Плавно: скачок камеры читается как сбой отрисовки. */
function applyViewPreset(name) {
  const target = VIEW_PRESETS[name];
  if (!study || !target || fourth !== 'volume') return;
  const v = view.volume;
  const from = { yaw: v.yaw, pitch: v.pitch };
  const dYaw = -angleDelta(from.yaw, target.yaw);
  const dPitch = target.pitch - from.pitch;
  if (viewAnim) cancelAnimationFrame(viewAnim);
  const t0 = performance.now();
  const DUR = 280;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / DUR);
    const e = 1 - Math.pow(1 - k, 3);
    v.yaw = from.yaw + dYaw * e;
    v.pitch = from.pitch + dPitch * e;
    // Пока идёт переход, считаем объём мельче — как при вращении пальцем.
    v.moving = k < 1;
    drawVolumePane();
    viewAnim = k < 1 ? requestAnimationFrame(step) : null;
  };
  viewAnim = requestAnimationFrame(step);
}

/** Подсветка кнопки ракурса, если камера стоит именно так. */
function updateViewButtons() {
  const box = document.getElementById('views');
  if (!box) return;
  const on = !!study && fourth === 'volume';
  box.hidden = !on;
  if (!on) return;
  const v = view.volume;
  for (const btn of box.querySelectorAll('.view-btn')) {
    const t = VIEW_PRESETS[btn.dataset.view];
    btn.classList.toggle('is-active',
      !!t && Math.abs(angleDelta(v.yaw, t.yaw)) < 0.04 && Math.abs(v.pitch - t.pitch) < 0.04);
  }
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

// Ручка разворота: за неё каркас поворачивают вокруг нормали панели. Радиус в
// точках устройства — палец на телефоне и курсор на Mac целятся одинаково.
const HANDLE_R = 52;
const HANDLE_HIT = 26;

/** Где сейчас ручка разворота этой панели, в точках canvas. */
function handleAt(plane, map) {
  const [x, y] = voxelToScreen(map, study.layouts[plane], crosshair);
  return { x: x + HANDLE_R, y, cx: x, cy: y };
}

function drawCrosshair(ctx, canvas, plane, map) {
  const layout = study.layouts[plane];
  const [x, y] = voxelToScreen(map, layout, crosshair);
  ctx.strokeStyle = 'rgba(76,142,255,0.55)';
  ctx.lineWidth = 1;
  const gap = 10;
  ctx.beginPath();
  ctx.moveTo(x, 0); ctx.lineTo(x, y - gap);
  ctx.moveTo(x, y + gap); ctx.lineTo(x, canvas.height);
  ctx.moveTo(0, y); ctx.lineTo(x - gap, y);
  ctx.moveTo(x + gap, y); ctx.lineTo(canvas.width, y);
  ctx.stroke();

  // Ручка. Без неё развернуть срез нечем: тянуть за сами линии нельзя, они
  // уже заняты — за них листают срезы.
  const live = rotating?.plane === plane ? rotating.angle : 0;
  const hx = x + HANDLE_R * Math.cos(live);
  const hy = y + HANDLE_R * Math.sin(live);
  if (live) {
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(hx, hy);
    ctx.strokeStyle = 'rgba(76,142,255,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(hx, hy, 5, 0, Math.PI * 2);
  ctx.fillStyle = live ? '#4C8EFF' : 'rgba(76,142,255,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
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
    if (p.chipName && layout) p.chipName.textContent = layout.name;
    if (!layout || !layout.trusted) {
      p.markL.hidden = true;
      p.markR.hidden = true;
      continue;
    }
    p.markL.hidden = false;
    p.markR.hidden = false;
    p.markL.textContent = layout.left;
    p.markR.textContent = layout.right;
  }
  updateChips();
}

/*
  Значение в чипе — положение среза вдоль нормали, от середины объёма, в
  миллиметрах. Это то же число, что врач видит на Mac рядом с названием
  проекции, и по нему он понимает, где находится, не считая срезы.

  Без размера точки числа нет вовсе: подписать миллиметрами то, что в них не
  измеряется, — хуже, чем не подписать.
*/
function updateChips() {
  if (!study) return;
  const mm = study.geometry.mm;
  const size = [study.geometry.voxel.i, study.geometry.voxel.j, study.geometry.voxel.k];
  for (const plane of PLANES) {
    const p = panes.get(plane);
    const layout = study.layouts[plane];
    if (!p?.chipValue || !layout) continue;
    if (!mm) {
      p.chipValue.textContent = 'без масштаба';
      p.chipUnit.textContent = '';
      continue;
    }
    const N = planeBasis(layout, rotation).N;
    let off = 0;
    for (let a = 0; a < 3; a++) off += (crosshair[a] - (study.dims[a] - 1) / 2) * size[a] * N[a];
    // Минус — настоящий, а не дефис: он стоит рядом с числом и должен быть
    // одной ширины со знаком плюс в моноширинном наборе.
    p.chipValue.textContent = (off < 0 ? '−' : '') + Math.abs(off).toFixed(1);
    p.chipUnit.textContent = 'мм';
  }
}

// ─── Инструменты ───────────────────────────────────────────────────────────

function updateTools() {
  for (const btn of document.querySelectorAll('.tool')) {
    const name = btn.dataset.tool;
    const slab = name === 'slab';
    const erase = name === 'erase';
    let usable = !!study;
    if (slab) usable = usable && fourth === 'panorama' && !!study.arch;
    // Стирать нечего — кнопка не должна выглядеть работающей.
    if (erase) usable = usable && (measures.length > 0 || !!pending);
    btn.disabled = !usable;
    btn.classList.toggle('is-active', usable && !slab && !erase && tool === name);
    if (slab) {
      const span = btn.querySelector('span');
      const mm = study?.arch?.slabMM;
      if (span) span.textContent = usable && mm ? 'Слой ' + (mm < 10 ? mm.toFixed(1) : mm) : 'Слой';
    }
    if (erase) {
      const span = btn.querySelector('span');
      if (span) span.textContent = eraseArmed ? 'Точно?' : 'Стереть';
      btn.classList.toggle('is-armed', usable && eraseArmed);
    }
  }
}

/*
  Удаление разметки спрашивает подтверждение, как на Mac. Диалога здесь нет
  намеренно: на телефоне он закрывает снимок целиком ради одного вопроса.
  Вместо него кнопка взводится первым нажатием и стирает вторым, а через
  четыре секунды сама возвращается в исходное — промах ничего не стоит.
*/
let eraseArmed = false;
let eraseTimer = null;

function armErase() {
  if (eraseTimer) clearTimeout(eraseTimer);
  if (eraseArmed) {
    eraseArmed = false;
    eraseTimer = null;
    clearMeasures();
    updateTools();
    return;
  }
  eraseArmed = true;
  eraseTimer = setTimeout(() => { eraseArmed = false; eraseTimer = null; updateTools(); }, 4000);
  updateTools();
}

function disarmErase() {
  if (!eraseArmed) return;
  if (eraseTimer) clearTimeout(eraseTimer);
  eraseArmed = false;
  eraseTimer = null;
}

function useTool(name) {
  if (!study) return;
  if (name !== 'erase') disarmErase();
  if (name === 'reset') { resetView(); return; }
  if (name === 'slab') { cycleSlab(); return; }
  if (name === 'erase') { armErase(); return; }
  tool = tool === name ? 'navigate' : name;
  pending = null;
  updateTools();
  drawAll();
}

/** Толщина слоя развёртки по кругу: 25 → 10 → 5 → 1.5 мм. */
function cycleSlab() {
  if (fourth !== 'panorama' || !study.arch) return;
  const at = SLAB_STEPS.indexOf(study.arch.slabMM);
  study.arch.slabMM = SLAB_STEPS[(at + 1) % SLAB_STEPS.length];
  updateTools();
  drawVolumePane();
}

function resetView() {
  for (const plane of PLANES) view[plane] = { zoom: 1, panU: 0, panV: 0 };
  view.volume.yaw = 0;
  view.volume.pitch = 0;
  view.volume.zoom = 1;
  view.volume.panX = 0;
  view.volume.panY = 0;
  // Сброс вида возвращает и разворот: иначе «сброс» оставляет срез косым.
  rotation = noRotation();
  rotating = null;
  panoView = { zoom: 1, panX: 0, panY: 0 };
  if (study.arch) study.arch.slabMM = SLAB_STEPS[0];
  resetVolumeLook();
  crosshair = study.dims.map((n) => (n - 1) / 2);
  study.look = autoWindow(study.histogram, study.series);
  pending = null;
  // Сброс вида не трогает разметку — но взведённую кнопку удаления снимает:
  // иначе она осталась бы заряженной на чужое действие.
  disarmErase();
  updateTools();
  drawAll();
}

/**
 * Плотность, с которой начинается кость. Берём по окну самого снимка: нижняя
 * граница окна — это мягкие ткани, верхняя — эмаль, кость между ними.
 */
function resetVolumeLook() {
  const low = study.look.center - study.look.width / 2;
  view.volume.threshold = low + study.look.width * 0.55;
  view.volume.softness = Math.max(150, study.look.width * 0.12);
}

/** Убрать всю разметку. Отдельно от сброса вида: это разные действия. */
export function clearMeasures() {
  measures = [];
  pending = null;
  updateTools();
  drawAll();
}

// ─── Рука врача ────────────────────────────────────────────────────────────

// Толщина слоя развёртки. Толстый показывает весь зубной ряд разом, тонкий
// режет ровно по дуге. Переключается кнопкой «Слой»: жест удержания путал —
// врач принимал его за смену среза.
const SLAB_STEPS = [25, 10, 5, 1.5];

const MOVE_THRESHOLD = 6;      // меньше — это касание, а не движение

function bindPointer(plane) {
  const p = panes.get(plane);
  const canvas = p.canvas;
  const points = new Map();
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!study) return;
    capture(canvas, e);
    points.set(e.pointerId, pos(canvas, e));
    if (points.size === 1) {
      const at = pos(canvas, e);
      const h = handleAt(plane, mapFor(plane));
      if (Math.hypot(at.x - h.x, at.y - h.y) <= HANDLE_HIT) {
        // Взялись за ручку — дальше это разворот, а не листание.
        const from = Math.atan2(at.y - h.cy, at.x - h.cx);
        rotating = { plane, angle: from };
        drag = { rotate: true, from, rot: rotation, moved: true };
      } else {
        drag = { start: at, moved: false, center: crosshair.slice(),
          look: { ...study.look }, pan: { ...view[plane] } };
      }
    } else if (points.size === 2) {
      const [a, b] = [...points.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Запоминаем ТОЧКУ ОБЪЁМА под пальцами: она и должна остаться под ними,
      // как бы врач ни свёл и ни развёл пальцы.
      drag = {
        pinch: Math.hypot(a.x - b.x, a.y - b.y),
        mid,
        anchor: screenToVoxel(mapFor(plane), mid.x, mid.y),
        state: { ...view[plane] },
        zoom: view[plane].zoom,
        moved: true,
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!study || !points.has(e.pointerId)) return;
    points.set(e.pointerId, pos(canvas, e));

    if (drag?.pinch) {
      const two = [...points.values()];
      if (two.length < 2) return;
      const now = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      const mid = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
      const zoom = drag.pinch > 4
        ? Math.min(8, Math.max(1, drag.zoom * now / drag.pinch))
        : view[plane].zoom;
      const layout = study.layouts[plane];
      // Ставим запомненную точку объёма ровно под текущую середину пальцев:
      // это разом даёт и увеличение к месту, и перемещение двумя пальцами.
      const next = { ...drag.state, zoom, index: crosshair[layout.n] };
      const map = screenMap(study.geometry, layout, study.dims,
        canvas.width, canvas.height, next);
      const at = voxelToScreen(map, layout, drag.anchor);
      next.panU -= (mid.x - at[0]) * map.mmPerPixel * (layout.u.flip ? -1 : 1);
      next.panV -= (mid.y - at[1]) * map.mmPerPixel * (layout.v.flip ? -1 : 1);
      view[plane] = { zoom: next.zoom, panU: next.panU, panV: next.panV };
      drawPane(plane);
      return;
    }
    if (!drag || drag.pinch) return;

    if (drag.rotate) {
      const at = pos(canvas, e);
      const h = handleAt(plane, mapFor(plane));
      const now = Math.atan2(at.y - h.cy, at.x - h.cx);
      rotating = { plane, angle: now };
      // Знак: экранный угол растёт по часовой (ось Y вниз), а поворот каркаса
      // на +α уводит точки изображения против часовой. Минус возвращает
      // картинку под палец — то же правило, что у увеличения к пальцам.
      rotation = rotateAround(drag.rot, planeBasis(study.layouts[plane], drag.rot).N,
        -(now - drag.from));
      drawAll();
      return;
    }

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
    const size = [study.geometry.voxel.i, study.geometry.voxel.j, study.geometry.voxel.k];
    const spanMM = study.dims[layout.n] * size[layout.n];
    const perPixel = spanMM / Math.max(1, canvas.height * 0.9);
    moveAlong(drag.center, planeBasis(layout, rotation).N, dy * perPixel);
    drawAll();
  });

  const end = (e) => {
    points.delete(e.pointerId);
    if (points.size === 0) { rotating = null; drawPane(plane); }
    if (!study) { drag = null; return; }
    const wasDrag = drag;
    if (points.size === 0) drag = null;
    if (!wasDrag || wasDrag.moved || wasDrag.pinch) return;
    tap(plane, pos(canvas, e));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => { points.delete(e.pointerId); drag = null; });
}

/**
 * Объёмный вид вращают пальцем, развёртку — прижимают.
 *
 * Удержание на развёртке делает слой тонким: толстый показывает весь зубной
 * ряд разом, тонкий режет ровно по дуге. На Mac это тот же жест.
 */
function bindVolumePointer() {
  const p = panes.get('volume');
  const canvas = p.canvas;
  const points = new Map();
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!study) return;
    capture(canvas, e);
    points.set(e.pointerId, pos(canvas, e));
    if (fourth === 'panorama') {
      if (points.size === 1) {
        drag = { start: pos(canvas, e), pan: { x: panoView.panX, y: panoView.panY } };
      } else if (points.size === 2) {
        const [a, b] = [...points.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        drag = {
          pinch: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: panoView.zoom,
          anchor: panoPointAt(mid),
        };
      }
      return;
    }
    if (points.size === 1) {
      drag = { start: pos(canvas, e), yaw: view.volume.yaw, pitch: view.volume.pitch };
      view.volume.moving = true;
    } else if (points.size === 2) {
      const [a, b] = [...points.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      drag = {
        pinch: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: view.volume.zoom,
        anchor: volumePointAt(canvas, mid),
      };
      view.volume.moving = true;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!study || !points.has(e.pointerId)) return;
    points.set(e.pointerId, pos(canvas, e));
    if (!drag) return;

    if (fourth === 'panorama') {
      if (drag.pinch) {
        // Один палец убрали посреди щипка — второму продолжать нечего.
        const two = [...points.values()];
        if (two.length < 2) return;
        const now = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
        const mid = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
        if (drag.pinch > 4) panoView.zoom = Math.min(8, Math.max(1, drag.zoom * now / drag.pinch));
        // Запомненная точка картинки возвращается под пальцы.
        panoPutUnder(drag.anchor, mid);
      } else {
        const here = pos(canvas, e);
        panoView.panX = drag.pan.x + (here.x - drag.start.x);
        panoView.panY = drag.pan.y + (here.y - drag.start.y);
      }
      drawVolumePane();
      return;
    }

    if (drag.pinch) {
      const two = [...points.values()];
      if (two.length < 2) return;
      const now = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      const mid = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
      if (drag.pinch > 4) {
        view.volume.zoom = Math.min(6, Math.max(0.5, drag.zoom * now / drag.pinch));
      }
      volumePutUnder(canvas, drag.anchor, mid);
      drawVolumePane();
      return;
    }
    const here = pos(canvas, e);
    // Пол-экрана — полоборота: так же, как на Mac после ручной настройки.
    view.volume.yaw = drag.yaw + (here.x - drag.start.x) / canvas.width * Math.PI * 2;
    view.volume.pitch = Math.max(-1.4, Math.min(1.4,
      drag.pitch + (here.y - drag.start.y) / canvas.height * Math.PI));
    drawVolumePane();
  });

  const release = (e) => {
    points.delete(e.pointerId);
    if (points.size > 0) return;
    drag = null;
    if (!study || !view) return;
    if (fourth === 'panorama') return;
    if (view.volume?.moving) {
      view.volume.moving = false;
      drawVolumePane();   // отпустили — перерисовываем мелким шагом
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

/**
 * Захват указателя необязателен: жест работает и без него, пока палец на
 * экране. Safari же бросает, если касание успело завершиться, и это
 * исключение всплывало наверх — врач видел «Не получилось» на ровном месте.
 */
function capture(canvas, e) {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (err) {
    // Не беда: без захвата события всё равно доходят до этого canvas.
  }
}

/** Какая точка развёртки лежит под этой точкой экрана. */
function panoPointAt(at) {
  const l = panoView.last;
  if (!l) return { x: 0, y: 0 };
  const scale = l.base * panoView.zoom;
  return {
    x: (at.x - (l.canvasW - l.width * scale) / 2 - panoView.panX) / scale,
    y: (at.y - (l.canvasH - l.height * scale) / 2 - panoView.panY) / scale,
  };
}

/** Кладёт точку развёртки под заданную точку экрана. */
function panoPutUnder(point, at) {
  const l = panoView.last;
  if (!l) return;
  const scale = l.base * panoView.zoom;
  panoView.panX = at.x - point.x * scale - (l.canvasW - l.width * scale) / 2;
  panoView.panY = at.y - point.y * scale - (l.canvasH - l.height * scale) / 2;
}

/**
 * Куда в миллиметрах смотрит эта точка экрана в объёмном виде. Считается по
 * той же формуле, что в шейдере, — иначе щипок и картинка разойдутся.
 */
function volumeNDC(canvas, at) {
  return {
    x: (at.x / canvas.width) * 2 - 1,
    y: 1 - (at.y / canvas.height) * 2,
  };
}

function volumePointAt(canvas, at) {
  const v = view.volume;
  const half = halfView(study.space.sizeMM, canvas.width / canvas.height, v.zoom);
  const ndc = volumeNDC(canvas, at);
  return { x: ndc.x * half.x - v.panX, y: ndc.y * half.y - v.panY };
}

function volumePutUnder(canvas, point, at) {
  const v = view.volume;
  const half = halfView(study.space.sizeMM, canvas.width / canvas.height, v.zoom);
  const ndc = volumeNDC(canvas, at);
  v.panX = ndc.x * half.x - point.x;
  v.panY = ndc.y * half.y - point.y;
}

function pos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / Math.max(1, rect.width);
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
}

function setIndex(axis, value) {
  crosshair[axis] = Math.min(study.dims[axis] - 1, Math.max(0, value));
}

/**
 * Сдвинуть перекрестие на столько миллиметров вдоль вектора.
 *
 * У прямого среза это то же самое, что сменить номер среза. У косого номера
 * среза нет вовсе: плоскость идёт поперёк всех трёх осей сразу, и листать
 * можно только вдоль её собственной нормали.
 */
function moveAlong(from, vec, mm) {
  const size = [study.geometry.voxel.i, study.geometry.voxel.j, study.geometry.voxel.k];
  for (let a = 0; a < 3; a++) {
    const next = from[a] + mm * vec[a] / size[a];
    crosshair[a] = Math.min(study.dims[a] - 1, Math.max(0, next));
  }
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
    updateTools();   // появилось что стирать — кнопка оживает
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
    arch: study.arch ? { lengthMM: study.arch.lengthMM, pixelMM: study.arch.pixelMM } : null,
    archReason,
    shaders: {
      срезы: !renderer?.broken,
      развёртка: !!pano && !pano.broken,
      объём: !!volume3d && !volume3d.broken,
    },
    fourth,
    dims: study.dims,
    reduction: study.reduction,
    mm: study.geometry.mm,
    voxel: study.geometry.voxel,
    notes: study.notes,
    crosshair: crosshair.slice(),
    measures: measures.map((m) => ({ kind: m.kind, plane: m.plane, text: measureText(m) })),
    zoom: view?.axial?.zoom ?? 1,
    window: { center: study.look.center, width: study.look.width },
    rotation: rotation.map((r) => r.slice()),
    volume: view?.volume
      ? { yaw: view.volume.yaw, pitch: view.volume.pitch, zoom: view.volume.zoom }
      : null,
    pano: panoView?.last
      ? { base: panoView.last.base, fit: panoView.last.fit, zoom: panoView.zoom }
      : null,
  };
}

/** Для проверок: точка экрана панели → точка объёма. */
export function fromScreen(plane, px, py) {
  if (!study) return null;
  return screenToVoxel(mapFor(plane), px, py);
}

/** Для проверок: сколько занимает один кадр четвёртой панели, мс. */
export function timeFourth(mode, frames = 3) {
  if (!study) return null;
  setFourth(mode);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) drawVolumePane();
  // Рисование в WebGL отложенное: без чтения пикселя замер показал бы ноль.
  const gl = renderer.gl;
  const probe = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
  return (performance.now() - t0) / frames;
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
  updateTools();
  drawPane(plane);
  return measureText(m);
}

// Опоры для автоматических проверок.
//
// Через import их не взять: у './viewer.js?v=0.7.0' и './viewer.js?v=0.7.0'
// разные экземпляры модуля, и проверка получила бы пустой просмотр вместо
// открытого. Номер в адресе меняется каждый выпуск, поэтому проверки
// цепляются сюда, а не за адрес. Внутренности приложения в браузере и так
// открыты — тайны тут нет.
globalThis.__vidiViewer = {
  state: viewerState, paneMap, toScreen, fromScreen, measureAt, setZoom, selectPlane,
  clearMeasures, setFourth, timeFourth, handleAt: testHandle, spinBy,
};

/** Для проверок: где ручка разворота панели. */
function testHandle(plane) {
  if (!study) return null;
  return handleAt(plane, mapFor(plane));
}

/** Для проверок: довернуть каркас вокруг нормали панели на угол. */
function spinBy(plane, angle) {
  if (!study) return null;
  rotation = rotateAround(rotation, planeBasis(study.layouts[plane], rotation).N, angle);
  drawAll();
  return rotation.map((r) => r.slice());
}
