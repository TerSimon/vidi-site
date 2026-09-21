//
//  Какая ось объёма куда смотрит на экране.
//
//  Объём приходит с аппарата не всегда «как принято»: у MyRay в одном
//  исследовании лежат и осевая съёмка, и сагиттальная развёртка, записанная
//  теми же номерами осей. Если считать, что первая ось — это всегда «вправо»,
//  сагиттальная серия откроется под именем аксиальной, с буквами R и L не на
//  тех краях. На Mac это уже случалось; здесь стороны берутся из направлений
//  осей в заголовке, а не из порядка чисел в файле.
//
//  Если направлений в заголовке нет, букв на экране не будет вовсе: подписать
//  сторону наугад — значит однажды оперировать не ту.
//

import { patientAxes } from './geometry.js?v=0.8.0';

export const PLANES = ['axial', 'sagittal', 'coronal'];

const OPPOSITE = { L: 'R', R: 'L', A: 'P', P: 'A', S: 'I', I: 'S' };

// Куда должны смотреть край и верх каждой панели — как принято в лучевой
// диагностике: на аксиальном срезе левая сторона пациента справа на экране,
// спереди — сверху.
const WANT = {
  axial: { x: 'L', y: 'P' },
  sagittal: { x: 'P', y: 'I' },
  coronal: { x: 'L', y: 'I' },
};

// Запасная раскладка, когда направления осей неизвестны: просто оси массива.
const RAW = {
  axial: { u: 0, v: 1, n: 2 },
  sagittal: { u: 1, v: 2, n: 0 },
  coronal: { u: 0, v: 2, n: 1 },
};

// Латиница: Axial/Sagittal/Coronal — это адресация проекции, одинаковая во
// всех вьюверах и в подписях к снимкам, а не перевод.
const NAMES = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' };

/**
 * Раскладка одной панели: какая ось объёма идёт вправо, какая вниз, какая
 * поперёк. `trusted: false` означает, что стороны неизвестны и подписывать их
 * нельзя.
 */
export function planeLayout(g, plane) {
  const axes = g.mm ? patientAxes(g) : null;
  if (!axes) {
    const raw = RAW[plane];
    return {
      plane, name: NAMES[plane], trusted: false,
      u: { axis: raw.u, flip: false },
      v: { axis: raw.v, flip: false },
      n: raw.n,
      left: '', right: '', top: '', bottom: '',
    };
  }

  const letters = [axes.i, axes.j, axes.k];
  const want = WANT[plane];
  const pick = (target) => {
    for (let a = 0; a < 3; a++) {
      if (letters[a] === target) return { axis: a, flip: false };
      if (letters[a] === OPPOSITE[target]) return { axis: a, flip: true };
    }
    return null;
  };

  const u = pick(want.x);
  const v = pick(want.y);
  if (!u || !v || u.axis === v.axis) {
    // Две оси смотрят в одну сторону — такого не бывает у исправной геометрии.
    return planeLayout({ ...g, mm: false }, plane);
  }
  const n = 3 - u.axis - v.axis;

  return {
    plane, name: NAMES[plane], trusted: true,
    u, v, n,
    left: OPPOSITE[want.x], right: want.x,
    top: OPPOSITE[want.y], bottom: want.y,
  };
}

/**
 * Перевод экранного пикселя в координаты объёма.
 *
 * Считается в миллиметрах: сколько миллиметров приходится на пиксель, столько
 * и откладывается по каждой оси. Поэтому точка объёма с шагом 0.2 мм поперёк и
 * 0.5 мм вдоль не растягивается — на экране сохраняются настоящие пропорции,
 * и линейка по диагонали не врёт.
 */
export function screenMap(g, layout, dims, widthPx, heightPx, state) {
  const size = [g.voxel.i, g.voxel.j, g.voxel.k];
  const mmU = dims[layout.u.axis] * size[layout.u.axis];
  const mmV = dims[layout.v.axis] * size[layout.v.axis];
  const zoom = state?.zoom ?? 1;
  const fit = Math.max(mmU / Math.max(1, widthPx), mmV / Math.max(1, heightPx));
  const mmPerPixel = fit / zoom;

  // Косой срез: панель развёрнута в пространстве, и её направления больше не
  // совпадают с осями массива. Шейдер это умеет с самого начала — он берёт
  // origin и два произвольных шага, — поэтому разворот целиком считается тут.
  if (state?.basis && state?.center) {
    const { U, V } = state.basis;
    const c = state.center;
    // Из миллиметров в точки: вдоль каждой оси свой размер точки.
    const stepX = [0, 1, 2].map((a) => mmPerPixel * U[a] / size[a]);
    const stepY = [0, 1, 2].map((a) => mmPerPixel * V[a] / size[a]);
    const panU = state.panU ?? 0;
    const panV = state.panV ?? 0;
    const center = [0, 1, 2].map((a) => c[a] + (panU * U[a] + panV * V[a]) / size[a]);
    const origin = [0, 1, 2].map((a) =>
      center[a] - stepX[a] * (widthPx - 1) / 2 - stepY[a] * (heightPx - 1) / 2);
    return { origin, stepX, stepY, mmPerPixel, mmU, mmV, size, U, V };
  }

  const sx = mmPerPixel / size[layout.u.axis] * (layout.u.flip ? -1 : 1);
  const sy = mmPerPixel / size[layout.v.axis] * (layout.v.flip ? -1 : 1);

  const panU = (state?.panU ?? 0) / size[layout.u.axis];
  const panV = (state?.panV ?? 0) / size[layout.v.axis];
  const centerU = (dims[layout.u.axis] - 1) / 2 + panU;
  const centerV = (dims[layout.v.axis] - 1) / 2 + panV;

  const origin = [0, 0, 0];
  const stepX = [0, 0, 0];
  const stepY = [0, 0, 0];
  origin[layout.u.axis] = centerU - sx * (widthPx - 1) / 2;
  origin[layout.v.axis] = centerV - sy * (heightPx - 1) / 2;
  origin[layout.n] = state?.index ?? (dims[layout.n] - 1) / 2;
  stepX[layout.u.axis] = sx;
  stepY[layout.v.axis] = sy;

  const U = [0, 0, 0]; U[layout.u.axis] = layout.u.flip ? -1 : 1;
  const V = [0, 0, 0]; V[layout.v.axis] = layout.v.flip ? -1 : 1;
  return { origin, stepX, stepY, mmPerPixel, mmU, mmV, size, U, V };
}

/**
 * Направления панели в пространстве объёма после разворота.
 *
 * Разворот двигает НОРМАЛИ плоскостей, а не экран. В той панели, за ручку
 * которой тянут, изображение стоит на месте, а поворачиваются линии
 * перекрестия — следы двух других плоскостей. Соседние панели становятся
 * косыми, но остаются «стоймя», а не заваливаются набок.
 *
 * Так устроено на Mac, и это не украшение: если вместе с каркасом крутить и
 * экран, врач теряет, где право и где верх, ровно в тот момент, когда ведёт
 * срез вдоль оси зуба.
 *
 * Считается так: нормаль поворачивается целиком, а направления экрана берутся
 * от исходной укладки и проецируются на новую плоскость. Поворот вокруг
 * собственной нормали панели оставляет их нетронутыми — отсюда неподвижная
 * картинка.
 */
export function planeBasis(layout, rot) {
  const axis = (a, flip) => { const v = [0, 0, 0]; v[a] = flip ? -1 : 1; return v; };
  const U0 = axis(layout.u.axis, layout.u.flip);
  const V0 = axis(layout.v.axis, layout.v.flip);
  const N0 = cross(U0, V0);
  if (!rot) return { U: U0, V: V0, N: N0 };
  const N = unit(apply(rot, N0));

  // Проекция исходного «вправо» на новую плоскость. Если оно почти совпало с
  // нормалью — опираемся на «вниз»: иначе остаток проекции это шум, и экран
  // прыгнет.
  let U = drop(U0, N);
  if (norm(U) < 0.15) U = cross(N, unit(drop(V0, N)));
  U = unit(U);
  const V = cross(N, U);   // так, что cross(U, V) снова даёт N
  return { U, V, N };
}

function drop(v, n) {
  const k = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  return [v[0] - k * n[0], v[1] - k * n[1], v[2] - k * n[2]];
}
function norm(v) { return Math.hypot(v[0], v[1], v[2]); }
function unit(v) {
  const l = norm(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : v;
}

function apply(m, v) {
  return [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Единичная матрица разворота. */
export function noRotation() {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

/**
 * Довернуть каркас на угол вокруг оси (в пространстве миллиметров объёма).
 *
 * Родригес: ось единичная, угол в радианах. Новый разворот применяется ПОВЕРХ
 * прежнего — врач крутит от того, что видит сейчас, а не от исходного.
 */
export function rotateAround(rot, axisVec, angle) {
  const len = Math.hypot(axisVec[0], axisVec[1], axisVec[2]);
  if (!(len > 1e-9) || !Number.isFinite(angle)) return rot;
  const [x, y, z] = axisVec.map((c) => c / len);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const R = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  return [0, 1, 2].map((r) => [0, 1, 2].map((col) =>
    R[r][0] * rot[0][col] + R[r][1] * rot[1][col] + R[r][2] * rot[2][col]));
}

/**
 * Увеличение вокруг точки экрана.
 *
 * Врач ведёт пальцы к тому месту, которое хочет разглядеть, — оно и должно
 * остаться под пальцами. Увеличение «в середину панели» уводит нужное место
 * за край, и приходится ловить его сдвигом.
 *
 * Возвращает новое состояние панели с поправленным сдвигом.
 */
export function zoomAround(g, layout, dims, widthPx, heightPx, state, px, py, zoom) {
  const before = screenMap(g, layout, dims, widthPx, heightPx, state);
  const voxel = screenToVoxel(before, px, py);
  const next = { ...state, zoom };
  const after = screenMap(g, layout, dims, widthPx, heightPx, next);
  const at = voxelToScreen(after, layout, voxel);
  // Чтобы сдвинуть картинку вправо на dx точек, середину панели надо увести
  // влево на столько же миллиметров — отсюда знак.
  next.panU = (next.panU ?? 0) - (px - at[0]) * after.mmPerPixel * (layout.u.flip ? -1 : 1);
  next.panV = (next.panV ?? 0) - (py - at[1]) * after.mmPerPixel * (layout.v.flip ? -1 : 1);
  return next;
}

/** Экранная точка → точка объёма. Тем же преобразованием, что и картинка. */
export function screenToVoxel(map, px, py) {
  return [0, 1, 2].map((c) => map.origin[c] + map.stepX[c] * px + map.stepY[c] * py);
}

/**
 * Точка объёма → экранная. Обратно к screenToVoxel.
 *
 * Считается проекцией на направления панели в миллиметрах: у косого среза ни
 * одна ось массива не совпадает с экраном, и делить на один компонент шага
 * больше нельзя. Для прямого среза формула даёт ровно прежний результат —
 * у него U и V единичные по своей оси, остальные нули.
 */
export function voxelToScreen(map, layout, voxel) {
  const { origin, size, U, V, mmPerPixel } = map;
  let x = 0;
  let y = 0;
  for (let a = 0; a < 3; a++) {
    const mm = (voxel[a] - origin[a]) * size[a];
    x += mm * U[a];
    y += mm * V[a];
  }
  return [x / mmPerPixel, y / mmPerPixel];
}
