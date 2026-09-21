//
//  Геометрия серии: из заголовка DICOM в миллиметры пациента.
//
//  Это единственное место, где решается, сколько миллиметров в точке объёма.
//  Линейка и угол считают только через него — не через пиксели экрана, не
//  через размер текстуры и не через зум. Поэтому уменьшение объёма под память
//  телефона меняет подробность картинки, но не меняет числа.
//
//  Здесь же решается, можно ли вообще показывать миллиметры. Если размера
//  точки нет, направления осей нет, шаг между срезами скачет или срезы сдвинуты
//  вбок — считать нельзя. Отказ честнее числа наугад: по этому числу выбирают
//  имплант.
//
//  Порядок в DICOM, на котором легко ошибиться и не заметить:
//
//    (0028,0030) PixelSpacing = [между строками, между столбцами].
//                Первое число — шаг ВНИЗ по строкам, второе — ВПРАВО.
//    (0020,0037) ImageOrientationPatient = [куда растёт номер столбца (6 чисел),
//                куда растёт номер строки]. Первая тройка — вдоль строки.
//
//  То есть шаг вдоль первой тройки берётся из ВТОРОГО числа PixelSpacing.
//  У всех знакомых аппаратов точка квадратная (0.2×0.2, 0.3×0.3), и перепутанные
//  местами числа не проявились бы никогда — до первого аппарата с
//  неквадратной точкой, где всё поедет молча. Поэтому в проверках лежит серия
//  с разным шагом по осям.
//

/** Насколько направления осей могут отклоняться от единичных и прямых углов. */
const UNIT_TOLERANCE = 1e-3;

/** Шаг между срезами считаем ровным, пока разброс не превысил эту долю. */
const STEP_TOLERANCE = 0.01;

/** Сдвиг срезов вбок, который ещё можно считать нулевым, мм. */
const DRIFT_TOLERANCE = 0.05;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.sqrt(dot(a, a));
const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/**
 * Строит геометрию серии.
 *
 * `series` — описание из заголовка: pixelSpacing, orientation, rows, columns.
 * `slices` — срезы с полем position (ImagePositionPatient).
 *
 * Возвращает объект с `mm: true`, если в миллиметрах считать можно, либо
 * `mm: false` и `reason` — причину словами врача.
 */
export function buildGeometry(series, slices) {
  const order = orderSlices(slices);

  const spacing = series.pixelSpacing;
  if (!Array.isArray(spacing) || spacing.length !== 2 ||
      !spacing.every((x) => Number.isFinite(x) && x > 0)) {
    return fail(order, 'В снимках не указан размер точки — измерения в миллиметрах невозможны.');
  }
  const [rowSpacing, colSpacing] = spacing;

  const iop = series.orientation;
  if (!Array.isArray(iop) || iop.length !== 6 || !iop.every(Number.isFinite)) {
    return fail(order, 'В снимках нет направления осей — стороны и измерения показать нельзя.');
  }
  const rowDir = iop.slice(0, 3);
  const colDir = iop.slice(3, 6);
  if (Math.abs(norm(rowDir) - 1) > UNIT_TOLERANCE || Math.abs(norm(colDir) - 1) > UNIT_TOLERANCE) {
    return fail(order, 'Направления осей в снимках заданы неверно.');
  }
  if (Math.abs(dot(rowDir, colDir)) > UNIT_TOLERANCE) {
    return fail(order, 'Оси снимка не под прямым углом — геометрии доверять нельзя.');
  }
  const normal = cross(rowDir, colDir);

  // Один срез — объёма нет, но плоскость измерить можно.
  if (order.length < 2) {
    return fail(order, 'В серии один срез — объём построить не из чего.');
  }

  const positions = order.map((s) => s.position);
  if (!positions.every(finite3)) {
    return fail(order, 'У части срезов нет положения в пространстве — расстояния вдоль объёма считать нельзя.');
  }

  // Шаг между срезами. Считаем вдоль нормали: именно так срезы и разложены.
  const proj = positions.map((p) => dot(p, normal));
  const steps = [];
  for (let k = 1; k < proj.length; k++) steps.push(proj[k] - proj[k - 1]);
  const step = steps.reduce((a, b) => a + b, 0) / steps.length;
  if (!Number.isFinite(step) || Math.abs(step) < 1e-6) {
    return fail(order, 'Срезы лежат в одной плоскости — объём построить нельзя.');
  }
  const spread = Math.max(...steps) - Math.min(...steps);
  if (spread > Math.abs(step) * STEP_TOLERANCE) {
    return fail(order,
      'Шаг между срезами неровный (' + spread.toFixed(2) +
      ' мм разброса) — измерения вдоль объёма были бы неточными.');
  }

  // Срезы должны отличаться только сдвигом вдоль нормали. Если серия ещё и
  // едет вбок, это не прямоугольный объём, и линейка по нему соврёт.
  const origin = positions[0];
  for (const p of positions) {
    const d = sub(p, origin);
    const drift = norm(sub(d, scale(normal, dot(d, normal))));
    if (drift > DRIFT_TOLERANCE) {
      return fail(order, 'Срезы смещены друг относительно друга — объём получился бы косым.');
    }
  }

  return {
    mm: true,
    reason: '',
    order,
    columns: series.columns,
    rows: series.rows,
    slices: order.length,
    // Шаг вдоль оси i (номер столбца) — это расстояние МЕЖДУ столбцами.
    voxel: { i: colSpacing, j: rowSpacing, k: Math.abs(step) },
    origin,
    // Оси объёма в пространстве пациента. k направлена так же, как растёт
    // номер среза в отсортированном порядке.
    axis: { i: rowDir, j: colDir, k: scale(normal, Math.sign(step)) },
  };
}

function scale(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }

/**
 * Геометрии нет — но снимок показать всё равно надо: врач открыл его, чтобы
 * смотреть. Поэтому возвращаем запасные оси и квадратную точку условного
 * размера. Картинка будет, а чисел не будет: `mm: false` закрывает и линейку,
 * и буквы сторон. Показать снимок и промолчать про миллиметры — честно;
 * показать миллиметры, которых не знаешь, — нет.
 */
function fail(order, reason) {
  return {
    mm: false, reason, order,
    columns: 0, rows: 0, slices: order.length,
    voxel: { i: 1, j: 1, k: 1 },
    origin: [0, 0, 0],
    axis: { i: [1, 0, 0], j: [0, 1, 0], k: [0, 0, 1] },
  };
}

/**
 * Порядок срезов. По положению в пространстве, а не по номеру в файле: номера
 * бывают с пропусками и задом наперёд, а положение — это факт.
 */
function orderSlices(slices) {
  const list = slices.slice();
  const withPos = list.filter((s) => finite3(s.position));
  if (withPos.length === list.length && list.length > 1) {
    // Направление раскладки берём по самой длинной оси разброса положений.
    const first = list[0].position;
    const last = list[list.length - 1].position;
    const along = sub(last, first);
    const len = norm(along);
    if (len > 1e-6) {
      const dir = scale(along, 1 / len);
      return list.slice().sort((a, b) => dot(a.position, dir) - dot(b.position, dir));
    }
  }
  return list.slice().sort((a, b) => (a.instance ?? 0) - (b.instance ?? 0));
}

/**
 * Точка объёма в миллиметрах пациента. i — номер столбца, j — номер строки,
 * k — номер среза. Дробные значения допустимы: линейка ставится не по клеткам.
 */
export function voxelToMM(g, i, j, k) {
  const { origin, axis, voxel } = g;
  return [0, 1, 2].map((c) =>
    origin[c] + i * voxel.i * axis.i[c] + j * voxel.j * axis.j[c] + k * voxel.k * axis.k[c]);
}

/** Расстояние между двумя точками объёма, мм. */
export function distanceMM(g, a, b) {
  const p = voxelToMM(g, a[0], a[1], a[2]);
  const q = voxelToMM(g, b[0], b[1], b[2]);
  return norm(sub(p, q));
}

/** Угол в точке b между лучами на a и c, градусы. */
export function angleDeg(g, a, b, c) {
  const p = voxelToMM(g, ...a);
  const q = voxelToMM(g, ...b);
  const r = voxelToMM(g, ...c);
  const u = sub(p, q);
  const v = sub(r, q);
  const lu = norm(u);
  const lv = norm(v);
  if (lu < 1e-9 || lv < 1e-9) return null;
  const cos = Math.min(1, Math.max(-1, dot(u, v) / (lu * lv)));
  return Math.acos(cos) * 180 / Math.PI;
}

/**
 * Геометрия объёма, уменьшенного под память устройства.
 *
 * Точка становится крупнее ровно во столько раз, во сколько ужали — и это
 * записано здесь же. Поэтому линейка на уменьшенном объёме показывает те же
 * миллиметры; крупнее становится шаг, которым можно ставить точку, и об этом
 * на экране говорится вслух.
 */
export function reduced(g, step) {
  if (step === 1) return g;
  return {
    ...g,
    columns: Math.ceil(g.columns / step),
    rows: Math.ceil(g.rows / step),
    slices: Math.ceil(g.slices / step),
    voxel: { i: g.voxel.i * step, j: g.voxel.j * step, k: g.voxel.k * step },
  };
}

/**
 * Куда смотрят стороны пациента вдоль осей объёма. Нужно для букв R/L и
 * названий плоскостей. Если направления осей не заданы, букв не будет:
 * подписать сторону наугад — значит однажды оперировать не ту.
 */
export function patientAxes(g) {
  if (!g.mm) return null;
  // LPS: +x влево пациента, +y назад, +z вверх.
  const letter = (v) => {
    const abs = v.map(Math.abs);
    const m = abs.indexOf(Math.max(...abs));
    const positive = v[m] > 0;
    if (m === 0) return positive ? 'L' : 'R';
    if (m === 1) return positive ? 'P' : 'A';
    return positive ? 'S' : 'I';
  };
  return { i: letter(g.axis.i), j: letter(g.axis.j), k: letter(g.axis.k) };
}
