// Пресеты перенесены из приложения без изменений:
//   TransferFunction.swift (3D) и SliceRenderer.Window (MPR).

const P = (hu, r, g, b, a) => ({ hu, c: [r, g, b], a });
const Z = (hu) => P(hu, 0, 0, 0, 0);

export const TRANSFER_FUNCTIONS = {
  bone: {
    name: 'Кость', huMin: -1000, huMax: 3500,
    points: [Z(-1000), Z(160), P(300, 0.78, 0.62, 0.45, 0.06), P(700, 0.92, 0.82, 0.62, 0.38),
      P(1500, 1.0, 0.95, 0.85, 0.85), P(3500, 1.0, 1.0, 0.98, 1.0)],
  },
  teeth: {
    name: 'Зубы', huMin: -1000, huMax: 4000,
    points: [Z(-1000), Z(400), P(1100, 1.0, 0.98, 0.92, 0.05), P(1600, 1.0, 0.98, 0.93, 0.55),
      P(2500, 1.0, 1.0, 0.98, 1.0), P(4000, 1.0, 1.0, 1.0, 1.0)],
  },
  skin: {
    name: 'Кожа', huMin: -1000, huMax: 3500,
    points: [Z(-1000), Z(-250), P(-110, 0.85, 0.55, 0.5, 0.1), P(20, 0.95, 0.72, 0.62, 0.55),
      P(90, 1.0, 0.8, 0.68, 0.3), P(200, 1.0, 0.8, 0.68, 0.04), Z(350), Z(3500)],
  },
  all: {
    name: 'Все ткани', huMin: -1000, huMax: 3500,
    points: [Z(-1000), Z(-300), P(-100, 0.85, 0.55, 0.5, 0.04), P(20, 0.95, 0.7, 0.6, 0.18),
      P(150, 0.75, 0.5, 0.42, 0.08), P(320, 0.78, 0.62, 0.45, 0.16), P(700, 0.92, 0.82, 0.62, 0.42),
      P(1500, 1.0, 0.96, 0.85, 0.85), P(3500, 1.0, 1.0, 1.0, 1.0)],
  },
  xrayTf: {
    name: 'X-Ray', huMin: -1000, huMax: 3500,
    points: [Z(-1000), Z(150), P(300, 0.74, 0.76, 0.79, 0.05), P(700, 0.86, 0.88, 0.91, 0.36),
      P(1500, 0.96, 0.97, 0.99, 0.85), P(3500, 1.0, 1.0, 1.0, 1.0)],
  },
};

/** Режимы 3D-окна в порядке меню. xray — проекция «Рентген» (DRR), без передаточной функции. */
export const VOLUME_MODES = [
  { id: 'teeth', label: 'Зубы' },
  { id: 'bone', label: 'Кость' },
  { id: 'all', label: 'Все ткани' },
  { id: 'skin', label: 'Кожа' },
  { id: 'xrayTf', label: 'X-Ray' },
  { id: 'xray', label: 'Рентген' },
];

/** Окна MPR (центр / ширина в единицах исследования). */
export const WINDOW_PRESETS = [
  { id: 'bone', label: 'Кость', center: 400, width: 1500 },
  { id: 'teeth', label: 'Зубы', center: 1000, width: 3000 },
  { id: 'soft', label: 'Мягкие ткани', center: 40, width: 400 },
];

export function bakeLUT(tf, entries = 256) {
  const pts = [...tf.points].sort((a, b) => a.hu - b.hu);
  const lut = new Uint8Array(entries * 4);
  const range = Math.max(1e-4, tf.huMax - tf.huMin);
  const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < entries; i++) {
    const hu = tf.huMin + (i / (entries - 1)) * range;
    let c = pts[pts.length - 1].c, a = pts[pts.length - 1].a;
    if (hu <= pts[0].hu) {
      c = pts[0].c; a = pts[0].a;
    } else {
      for (let j = 0; j < pts.length - 1; j++) {
        const p0 = pts[j], p1 = pts[j + 1];
        if (hu >= p0.hu && hu <= p1.hu) {
          const f = (hu - p0.hu) / Math.max(1e-4, p1.hu - p0.hu);
          c = [0, 1, 2].map((k) => p0.c[k] * (1 - f) + p1.c[k] * f);
          a = p0.a * (1 - f) + p1.a * f;
          break;
        }
      }
    }
    lut.set([q(c[0]), q(c[1]), q(c[2]), q(a)], i * 4);
  }
  return lut;
}
