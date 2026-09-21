//
//  Зубная дуга и развёртка вдоль неё.
//
//  Порт с Mac (`DentalArch.swift`, `PanoramicCurve.swift`,
//  `PanoramicReformatter.swift`) без изменения алгоритма: дуга подбирается по
//  самому снимку — по аксиальной проекции максимальной яркости, — а не по
//  найденным зубам. На Mac это уже выучено: среднее и медиана по найденному
//  уезжают, как только поиск сработал несимметрично, и уводят за собой стороны.
//
//  Кривая — Catmull-Rom: нормаль вдоль неё меняется плавно, без изломов на
//  стыках сегментов. Развёртка идёт по равным долям ДЛИНЫ дуги, поэтому
//  миллиметры по горизонтали панорамы настоящие.
//
//  Всё считается в плоскости аксиального вида (u, v) — не в осях массива.
//  Объём с аппарата бывает записан сагиттально, и дуга, построенная по осям
//  файла, оказалась бы поперёк челюсти.
//

/** Точка кривой Catmull-Rom. */
function catmullPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [0, 1].map((c) => 0.5 * (
    2 * p1[c] +
    (-p0[c] + p2[c]) * t +
    (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
    (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
}

/** Касательная к кривой Catmull-Rom. */
function catmullTangent(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return [0, 1].map((c) => 0.5 * (
    (-p0[c] + p2[c]) +
    2 * (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t +
    3 * (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t2));
}

const len2 = (v) => Math.hypot(v[0], v[1]);
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Плотная ломаная по кривой: точки и единичные касательные. Вырожденная
 * касательная (совпавшие контрольные точки) не превращается в NaN — берётся
 * предыдущая.
 */
export function subdivide(control, stepsPerSegment = 24) {
  if (control.length < 2) return { points: control.slice(), tangents: [[1, 0]] };
  const points = [];
  const tangents = [];
  for (let i = 0; i < control.length - 1; i++) {
    // Отражённые точки на концах дают нормальную кривизну у краёв.
    const p0 = i === 0 ? mirror(control[0], control[1]) : control[i - 1];
    const p1 = control[i];
    const p2 = control[i + 1];
    const p3 = i + 2 < control.length ? control[i + 2] : mirror(control[i + 1], control[i]);
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      points.push(catmullPoint(p0, p1, p2, p3, t));
      const tan = catmullTangent(p0, p1, p2, p3, t);
      const l = len2(tan);
      tangents.push(l > 1e-9 ? [tan[0] / l, tan[1] / l] : (tangents[tangents.length - 1] ?? [1, 0]));
    }
  }
  points.push(control[control.length - 1]);
  tangents.push(tangents[tangents.length - 1] ?? [1, 0]);
  return { points, tangents };
}

const mirror = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];

/**
 * Колонки развёртки: точка и нормаль на каждый столбец панорамы, через равные
 * доли длины дуги. Это единственный источник геометрии панорамы — и картинка,
 * и насечки на аксиальном виде считаются отсюда, иначе они разойдутся.
 */
export function sampledColumns(control, pixelMM) {
  const { points, tangents } = subdivide(control, 32);
  if (points.length < 2 || !(pixelMM > 0)) return { points: [], normals: [], lengthMM: 0 };

  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist2(points[i], points[i - 1]));
  const total = cum[cum.length - 1];
  if (!(total > 1e-3)) return { points: [], normals: [], lengthMM: 0 };

  const width = Math.max(1, Math.round(total / pixelMM));
  const outPts = new Array(width);
  const outNor = new Array(width);
  let cursor = 0;
  for (let i = 0; i < width; i++) {
    const s = (i + 0.5) * pixelMM;
    while (cursor + 1 < points.length - 1 && cum[cursor + 1] < s) cursor++;
    const segLen = cum[cursor + 1] - cum[cursor];
    const t = segLen > 1e-9 ? (s - cum[cursor]) / segLen : 0;
    outPts[i] = [
      points[cursor][0] + (points[cursor + 1][0] - points[cursor][0]) * t,
      points[cursor][1] + (points[cursor + 1][1] - points[cursor][1]) * t,
    ];
    const raw = [
      tangents[cursor][0] * (1 - t) + tangents[cursor + 1][0] * t,
      tangents[cursor][1] * (1 - t) + tangents[cursor + 1][1] * t,
    ];
    const l = len2(raw);
    const tan = l > 1e-9 ? [raw[0] / l, raw[1] / l] : tangents[cursor];
    outNor[i] = [-tan[1], tan[0]];
  }
  return { points: outPts, normals: outNor, lengthMM: total };
}

/**
 * Подбирает дугу по аксиальной проекции.
 *
 * `mip` — { data, width, height } в координатах (u, v) аксиального вида,
 * значения — исходные из DICOM. `size` — физический размер по u и v в мм.
 * `hu` — перевод значения в HU (slope/intercept и знак).
 *
 * Строки и столбцы с малым числом костных точек отбрасываются: по краям поля
 * зрения у конусно-лучевых снимков всегда шум, и без этого дуга растягивалась
 * бы на него.
 */
export function fitArch(mip, size, hu) {
  const { data, width, height } = mip;
  const threshold = (500 - hu.intercept) / (hu.slope || 1);

  const rowCount = new Int32Array(height);
  const colCount = new Int32Array(width);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (data[j * width + i] > threshold) { rowCount[j]++; colCount[i]++; }
    }
  }
  const rowNeed = Math.max(8, Math.floor(width / 20));
  const colNeed = Math.max(8, Math.floor(height / 20));
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let j = 0; j < height; j++) if (rowCount[j] >= rowNeed) { if (j < minY) minY = j; if (j > maxY) maxY = j; }
  for (let i = 0; i < width; i++) if (colCount[i] >= colNeed) { if (i < minX) minX = i; if (i > maxX) maxX = i; }
  if (maxX <= minX || maxY <= minY) return defaultArch(size);

  const cx = ((minX + maxX) / 2 + 0.5) * size.u / width;
  const cy = ((minY + maxY) / 2 + 0.5) * size.v / height;
  const w = (maxX - minX) * size.u / width * 0.92;
  const d = (maxY - minY) * size.v / height * 0.85;
  return archPoints(cx, cy, w, d);
}

/** Дуга по центру и размерам челюсти. Форма подобрана на Mac. */
function archPoints(cx, cy, w, d) {
  return [
    [cx - w / 2,   cy + d * 0.48],
    [cx - w / 2.4, cy + d * 0.10],
    [cx - w / 3.2, cy - d * 0.22],
    [cx - w / 6,   cy - d * 0.40],
    [cx,           cy - d * 0.45],
    [cx + w / 6,   cy - d * 0.40],
    [cx + w / 3.2, cy - d * 0.22],
    [cx + w / 2.4, cy + d * 0.10],
    [cx + w / 2,   cy + d * 0.48],
  ];
}

/** Запасная дуга, когда кости на снимке не нашлось. */
export function defaultArch(size) {
  return archPoints(size.u / 2, size.v / 2, size.u * 0.7, size.v * 0.6);
}

/** Длина дуги, мм. */
export function archLength(control) {
  const { points } = subdivide(control, 32);
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += dist2(points[i], points[i - 1]);
  return sum;
}
