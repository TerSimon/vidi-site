// Небольшая линейная алгебра для 3-векторов и 3×3 матриц (row-major: m[r*3+c]).

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampPoint = (p, size) => [
  clamp(p[0], 0, size[0]),
  clamp(p[1], 0, size[1]),
  clamp(p[2], 0, size[2]),
];

export const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const mulV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const mulM = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
};

/** Поворот вокруг оси на угол (правило правой руки) — как axisAngleRotation в приложении. */
export function axisAngle(axis, angle) {
  const [x, y, z] = norm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Возвращает ортонормальную матрицу: накопленные повороты не «плывут» от ошибок округления. */
export function orthonormalize(m) {
  const c0 = norm([m[0], m[3], m[6]]);
  let c1 = [m[1], m[4], m[7]];
  c1 = norm(sub(c1, scale(c0, dot(c0, c1))));
  const c2 = cross(c0, c1);
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

/** setPointerCapture бросает исключение, если палец уже отпущен (быстрый тап на iOS). */
export function capturePointer(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* указатель уже неактивен — жест просто завершится без захвата */
  }
}
