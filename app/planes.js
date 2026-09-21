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

import { patientAxes } from './geometry.js?v=0.4.3';

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

const NAMES = { axial: 'Аксиальная', sagittal: 'Сагиттальная', coronal: 'Корональная' };

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

  return { origin, stepX, stepY, mmPerPixel, mmU, mmV };
}

/** Экранная точка → точка объёма. Тем же преобразованием, что и картинка. */
export function screenToVoxel(map, px, py) {
  return [0, 1, 2].map((c) => map.origin[c] + map.stepX[c] * px + map.stepY[c] * py);
}

/** Точка объёма → экранная. Обратно к screenToVoxel. */
export function voxelToScreen(map, layout, voxel) {
  const u = layout.u.axis;
  const v = layout.v.axis;
  return [
    (voxel[u] - map.origin[u]) / map.stepX[u],
    (voxel[v] - map.origin[v]) / map.stepY[v],
  ];
}
