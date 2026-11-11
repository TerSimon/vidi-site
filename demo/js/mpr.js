// MPR-пейн: геометрия и навигация повторяют MPRPlaneGeometry / MPRNavigationGeometry
// приложения (Views/MPRPlaneGeometry.swift), поэтому поведение совпадает с Vidi.

import {
  add, sub, scale, dot, cross, norm, len, addScaled, clampPoint, mulV, axisAngle, mulM, orthonormalize, clamp,
  capturePointer,
} from './vec.js';

export const PLANES = {
  axial: { title: 'Axial', color: '#4C8EFF', normal: [0, 0, 1], down: [0, 1, 0] },
  sagittal: { title: 'Sagittal', color: '#FF6B6B', normal: [-1, 0, 0], down: [0, 0, -1] },
  coronal: { title: 'Coronal', color: '#4ED17E', normal: [0, 1, 0], down: [0, 0, -1] },
};
export const PLANE_KEYS = ['axial', 'sagittal', 'coronal'];

const MEASURE_COLOR = '#F2C14E'; // --amber: измерение
const STROKE_COLOR = 'rgba(76,142,255,0.95)'; // карандаш — как в Vidi Web
const PENCIL_SAMPLE_PX = 1.5; // реже хранить точки без видимых углов линии
const MOVE_THRESHOLD = 6; // меньше — касание, больше — протяжка

/** Длина линейки масштаба: круглое число не длиннее места под ней — в малом окне
 *  линейка не наезжает на подпись окна справа. */
const niceLength = (mm) => [100, 50, 20, 10, 5, 2, 1].find((s) => s <= mm) ?? 1;

/** u — экран вправо, v — экран вниз, n — нормаль. Изображение не вращается вместе с осями. */
export function basis(planeKey, R) {
  const pl = PLANES[planeKey];
  const n = norm(mulV(R, pl.normal));
  let v = sub(pl.down, scale(n, dot(pl.down, n)));
  if (len(v) < 1e-6) {
    const alt = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    v = sub(alt, scale(n, dot(alt, n)));
  }
  v = norm(v);
  const u = norm(cross(v, n));
  return { u, v, n };
}

/** Буква анатомической стороны для направления в LPS. */
export function sideLetter(d) {
  const ax = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const i = ax.indexOf(Math.max(...ax));
  if (i === 0) return d[0] > 0 ? 'L' : 'R';
  if (i === 1) return d[1] > 0 ? 'P' : 'A';
  return d[2] > 0 ? 'S' : 'I';
}

export const extentAlong = (d, size) =>
  Math.abs(d[0]) * size[0] + Math.abs(d[1]) * size[1] + Math.abs(d[2]) * size[2];

export class MprPane {
  constructor(app, el, planeKey) {
    this.app = app;
    this.el = el;
    this.plane = planeKey;
    this.W = 1;
    this.H = 1;
    this.pointers = new Map();
    this.gesture = null;

    this.svg = el.querySelector('.pane-ov');
    this.chipValue = el.querySelector('.chip-value');
    this.chipUnit = el.querySelector('.unit');
    this.surface = el.querySelector('.pane-surface');

    this._bind();
  }

  get s() {
    return this.app.state;
  }

  basis() {
    return basis(this.plane, this.s.R);
  }

  pixelMM() {
    const b0 = basis(this.plane, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const size = this.s.size;
    const fit = Math.max(extentAlong(b0.u, size) / Math.max(1, this.W),
      extentAlong(b0.v, size) / Math.max(1, this.H));
    return (fit * 1.04) / Math.max(0.2, this.s.zoom[this.plane]);
  }

  center() {
    return this.s.centers[this.plane];
  }

  screenToWorld(x, y) {
    const { u, v } = this.basis();
    const pmm = this.pixelMM();
    const c = this.center();
    return add(add(c, scale(u, (x - this.W / 2) * pmm)), scale(v, (y - this.H / 2) * pmm));
  }

  worldToScreen(p) {
    const { u, v } = this.basis();
    const pmm = this.pixelMM();
    const d = sub(p, this.center());
    return [this.W / 2 + dot(d, u) / pmm, this.H / 2 + dot(d, v) / pmm];
  }

  // ---------------------------------------------------------------- render

  glParams(level) {
    const { u, v, n } = this.basis();
    const pmm = this.pixelMM();
    const st = this.s;
    const range = st.huMax - st.huMin;
    const lo = (st.window.center - st.window.width / 2 - st.huMin) / range;
    const thick = st.thick;
    const minSp = Math.min(...level.spacing);
    const samples = thick > 0 ? clamp(Math.ceil(thick / (minSp * 0.5)) + 1, 4, 96) : 1;
    return {
      center: this.center(),
      u: scale(u, (this.W / 2) * pmm),
      v: scale(v, (this.H / 2) * pmm),
      n,
      size: st.size,
      thick,
      samples,
      lo,
      invW: range / Math.max(1, st.window.width),
    };
  }

  renderOverlay() {
    const st = this.s;
    const W = this.W, H = this.H;
    const { u, v, n } = this.basis();
    const cs = this.worldToScreen(st.crosshair);
    const parts = [];

    // Линии перекрестия: пересечение с двумя другими плоскостями, цвет — цвет той плоскости.
    this.handles = [];
    const r = 0.36 * Math.min(W, H);
    for (const other of PLANE_KEYS) {
      if (other === this.plane) continue;
      const on = basis(other, st.R).n;
      const d3 = cross(n, on);
      if (len(d3) < 1e-9) continue;
      let du = dot(d3, u), dv = dot(d3, v);
      const l2 = Math.hypot(du, dv);
      if (l2 < 1e-9) continue;
      du /= l2; dv /= l2;
      const L = W + H;
      const col = PLANES[other].color;
      parts.push(`<line x1="${cs[0] - du * L}" y1="${cs[1] - dv * L}" x2="${cs[0] + du * L}" y2="${cs[1] + dv * L}" stroke="${col}" stroke-opacity=".75" stroke-width="1"/>`);
      if (st.tool === 'nav') {
        for (const sgn of [-1, 1]) {
          const hx = cs[0] + du * r * sgn, hy = cs[1] + dv * r * sgn;
          const active = this.gesture && this.gesture.kind === 'rotate' && this.gesture.handle === `${other}${sgn}`;
          parts.push(`<circle cx="${hx}" cy="${hy}" r="${active ? 7 : 5.5}" fill="${col}" stroke="rgba(0,0,0,.45)" stroke-width="1"/>`);
          this.handles.push({ x: hx, y: hy, id: `${other}${sgn}` });
        }
      }
    }

    // Буквы сторон — слева и справа посередине, как в Vidi Web.
    const letter = (x, y, t, anchor) =>
      `<text x="${x}" y="${y}" class="ov-side" text-anchor="${anchor}" dominant-baseline="middle">${t}</text>`;
    parts.push(letter(8, H / 2, sideLetter(scale(u, -1)), 'start'));
    parts.push(letter(W - 8, H / 2, sideLetter(u), 'end'));

    // Линейка масштаба слева внизу и окно справа внизу — как в Vidi Web.
    const pmm = this.pixelMM();
    const mm = niceLength(Math.min(W * 0.25, 80) * pmm);
    const px = mm / pmm;
    const bx = 7, by = H - 9;
    parts.push(`<path d="M${bx} ${by}H${bx + px}M${bx} ${by - 4}V${by + 4}M${bx + px} ${by - 4}V${by + 4}" stroke="rgba(255,255,255,.7)" stroke-width="1" fill="none"/>`);
    parts.push(`<text x="${bx + px / 2}" y="${by - 6}" class="ov-label" text-anchor="middle">${mm} мм</text>`);
    parts.push(`<text x="${W - 7}" y="${H - 7}" class="ov-label" text-anchor="end" opacity=".8">окно ${Math.round(st.window.width)} · центр ${Math.round(st.window.center)}</text>`);

    // Измерения текущего среза.
    for (const m of this.app.visibleMeasurements(this)) parts.push(this._measureSVG(m, false));
    if (st.draft && st.draft.plane === this.plane) parts.push(this._measureSVG(st.draft, true));

    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = parts.join('');

    // Смещение среза от центра объёма — в чипе проекции, как в Vidi Web.
    // Минус — настоящий, а не дефис: одной ширины с цифрами в моноширинном наборе.
    const volC = scale(st.size, 0.5);
    const off = dot(sub(st.crosshair, volC), n);
    this.chipValue.textContent = (off < 0 ? '−' : '') + Math.abs(off).toFixed(1);
    this.chipUnit.textContent = 'мм';
  }

  _measureSVG(m, draft) {
    const pts = m.pts.map((p) => this.worldToScreen(p));
    if (m.type === 'stroke') {
      if (pts.length === 1) return `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="1.4" fill="${STROKE_COLOR}"/>`;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
      return `<path d="${d}" fill="none" stroke="${STROKE_COLOR}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const col = MEASURE_COLOR;
    const out = [];
    const dash = draft ? ' stroke-dasharray="4 3"' : '';
    for (let i = 0; i < pts.length - 1; i++) {
      out.push(`<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[i + 1][0]}" y2="${pts[i + 1][1]}" stroke="rgba(0,0,0,.55)" stroke-width="3"/>`);
      out.push(`<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[i + 1][0]}" y2="${pts[i + 1][1]}" stroke="${col}" stroke-width="1.5"${dash}/>`);
    }
    for (const p of pts) out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${col}" stroke="rgba(0,0,0,.6)"/>`);

    let text = '';
    let lx, ly;
    if (m.type === 'dist' && pts.length === 2 && len(sub(m.pts[1], m.pts[0])) >= 0.3) {
      text = `${len(sub(m.pts[1], m.pts[0])).toFixed(1)} мм`;
      lx = (pts[0][0] + pts[1][0]) / 2;
      ly = (pts[0][1] + pts[1][1]) / 2 - 14;
    } else if (m.type === 'angle' && pts.length === 3) {
      const a = norm(sub(m.pts[0], m.pts[1]));
      const b = norm(sub(m.pts[2], m.pts[1]));
      if (len(sub(m.pts[2], m.pts[1])) > 1e-6) {
        text = `${((Math.acos(clamp(dot(a, b), -1, 1)) * 180) / Math.PI).toFixed(1)}°`;
      }
      lx = pts[1][0] + 16;
      ly = pts[1][1] - 16;
    }
    if (text) {
      const w = text.length * 7 + 12;
      out.push(`<rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="20" rx="6" fill="rgba(10,13,20,.82)" stroke="rgba(242,193,78,.35)"/>`);
      out.push(`<text x="${lx}" y="${ly + 0.5}" class="ov-measure" text-anchor="middle" dominant-baseline="middle">${text}</text>`);
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- navigation

  setCrosshair(target) {
    const st = this.s;
    const p = clampPoint(target, st.size);
    const delta = sub(p, st.crosshair);
    st.crosshair = p;
    for (const k of PLANE_KEYS) {
      const nk = basis(k, st.R).n;
      const dn = dot(delta, nk);
      if (Math.abs(dn) > 1e-12) st.centers[k] = clampPoint(addScaled(st.centers[k], nk, dn), st.size);
    }
    this.app.invalidate();
  }

  scrollSlice(mm) {
    const { n } = this.basis();
    this.setCrosshair(addScaled(this.s.crosshair, n, mm));
  }

  rotate(delta) {
    const st = this.s;
    const { n } = this.basis();
    st.R = orthonormalize(mulM(axisAngle(n, delta), st.R));
    for (const k of PLANE_KEYS) {
      const nk = basis(k, st.R).n;
      const c = st.centers[k];
      st.centers[k] = sub(c, scale(nk, dot(sub(c, st.crosshair), nk)));
    }
    this.app.invalidate();
  }

  pan(dx, dy) {
    const { u, v } = this.basis();
    const pmm = this.pixelMM();
    const c = this.center();
    this.s.centers[this.plane] = clampPoint(sub(sub(c, scale(u, dx * pmm)), scale(v, dy * pmm)), this.s.size);
    this.app.invalidate();
  }

  zoomAt(factor, x, y) {
    const st = this.s;
    const old = st.zoom[this.plane];
    const next = clamp(old * factor, 0.5, 20);
    if (next === old) return;
    const { u, v } = this.basis();
    const cursor = this.screenToWorld(x, y);
    st.zoom[this.plane] = next;
    const newP = this.pixelMM();
    st.centers[this.plane] = clampPoint(
      sub(sub(cursor, scale(u, (x - this.W / 2) * newP)), scale(v, (y - this.H / 2) * newP)), st.size);
    this.app.invalidate();
  }

  resetZoom() {
    this.s.zoom[this.plane] = 1;
    this.s.centers[this.plane] = [...this.s.crosshair];
    this.app.invalidate();
  }

  windowDrag(dx, dy) {
    const w = this.s.window;
    const widthSens = Math.max(2, w.width / 100);
    const centerSens = Math.max(1, w.width / 200);
    this.app.setWindow(w.center + dy * centerSens, Math.max(1, w.width + dx * widthSens), true);
  }

  // ---------------------------------------------------------------- input

  _local(e) {
    const r = this.surface.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _bind() {
    const el = this.surface;
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // Колесо слушаем на всём окне.
    this.el.addEventListener('wheel', (e) => {
      if (!this.app.ready) return;
      e.preventDefault();
      const [x, y] = this._local(e);
      if (e.ctrlKey || e.metaKey) {
        // Пинч трекпада приходит как wheel + ctrlKey.
        this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), x, y);
        return;
      }
      let mm;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (e.deltaMode === 1) mm = d;
      else if (Math.abs(d) >= 50) mm = Math.sign(d);
      else mm = d * 0.08;
      if (e.altKey) {
        const { u, v } = this.basis();
        this.setCrosshair(add(addScaled(this.s.crosshair, u, -e.deltaX * 0.1), scale(v, -e.deltaY * 0.1)));
        return;
      }
      this.scrollSlice(mm);
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e, true));
    el.addEventListener('dblclick', (e) => {
      if (this.s.tool === 'nav') this.resetZoom();
      e.preventDefault();
    });

    // Safari (macOS): пинч трекпада — нестандартные gesture*-события.
    if (!this.app.isTouch) {
      let startZoom = 1;
      el.addEventListener('gesturestart', (e) => { e.preventDefault(); startZoom = 1; });
      el.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        const [x, y] = this._local(e);
        this.zoomAt(e.scale / startZoom, x, y);
        startZoom = e.scale;
      });
    }

  }

  _down(e) {
    if (!this.app.ready) return;
    const el = this.surface;
    capturePointer(el, e.pointerId);
    const [x, y] = this._local(e);
    this.pointers.set(e.pointerId, { x, y });
    this.app.touchPane(this.plane);

    if (this.pointers.size === 2) {
      // Второй палец: пинч + сдвиг. Начатое одним пальцем действие отменяем.
      if (this.gesture && (this.gesture.kind === 'measure' || this.gesture.kind === 'pencil')) this.app.cancelDraft();
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      };
      return;
    }
    if (this.pointers.size > 2) return;

    const st = this.s;
    if (e.button === 2) {
      this.gesture = { kind: 'window', last: [x, y] };
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.shiftKey && e.pointerType !== 'touch')) {
      e.preventDefault();
      this.gesture = { kind: 'pan', last: [x, y] };
      return;
    }

    const mouse = e.pointerType === 'mouse';
    if (st.tool === 'window') {
      // Как в Vidi Web: вправо — шире окно, вверх — светлее.
      const k = mouse ? 4 : 4 * Math.min(window.devicePixelRatio || 1, 2);
      this.gesture = { kind: 'windowTool', start: [x, y], look: { ...st.window }, k };
      return;
    }
    if (st.tool === 'pencil') {
      this.gesture = { kind: 'pencil', last: [x, y] };
      this.app.beginStroke(this, this.screenToWorld(x, y));
      return;
    }
    if (st.tool === 'nav') {
      const tol = mouse ? 12 : 24;
      const hit = (this.handles || []).find((h) => Math.hypot(h.x - x, h.y - y) <= tol);
      if (hit) {
        const cs = this.worldToScreen(st.crosshair);
        this.gesture = { kind: 'rotate', handle: hit.id, lastAngle: Math.atan2(y - cs[1], x - cs[0]) };
        this.app.invalidate();
        return;
      }
      if (mouse) {
        this.gesture = { kind: 'crosshair', start: [x, y], moved: false };
        this.setCrosshair(this.screenToWorld(x, y));
        return;
      }
    }
    if (!mouse) {
      // Палец — как в Vidi Web: касание ставит перекрестие или точку измерения,
      // протяжка листает срезы в любом инструменте; двигают снимок двумя пальцами.
      this.gesture = { kind: 'tap', start: [x, y], moved: false, from: [...st.crosshair] };
      return;
    }

    // Линейка / угол мышью.
    this.gesture = { kind: 'measure', start: [x, y], moved: false };
    this.app.measurePointerDown(this, this.screenToWorld(x, y));
  }

  _move(e) {
    const [x, y] = this._local(e);
    const p = this.pointers.get(e.pointerId);
    if (!this.gesture) {
      // Наведение без нажатия: предпросмотр следующей точки измерения.
      if (this.s.draft && this.s.draft.plane === this.plane && e.pointerType !== 'touch') {
        this.app.measureHover(this, this.screenToWorld(x, y));
      }
      return;
    }
    if (!p) return;
    const g = this.gesture;

    if (g.kind === 'pinch') {
      p.x = x; p.y = y;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.pan(mid[0] - g.mid[0], mid[1] - g.mid[1]);
      if (g.dist > 10) this.zoomAt(dist / g.dist, mid[0], mid[1]);
      g.dist = dist;
      g.mid = mid;
      return;
    }
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;

    switch (g.kind) {
      case 'window':
        this.windowDrag(dx, dy);
        break;
      case 'pan':
        this.pan(dx, dy);
        break;
      case 'rotate': {
        const cs = this.worldToScreen(this.s.crosshair);
        const ang = Math.atan2(y - cs[1], x - cs[0]);
        let delta = ang - g.lastAngle;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        g.lastAngle = ang;
        this.rotate(delta);
        break;
      }
      case 'crosshair':
        g.moved = true;
        this.setCrosshair(this.screenToWorld(x, y));
        break;
      case 'windowTool': {
        // Вверх — светлее: центр окна опускается.
        const ddx = x - g.start[0], ddy = y - g.start[1];
        this.app.setWindow(g.look.center + ddy * g.k, Math.max(50, g.look.width + ddx * g.k));
        break;
      }
      case 'pencil':
        if (Math.hypot(x - g.last[0], y - g.last[1]) < PENCIL_SAMPLE_PX) break;
        g.last = [x, y];
        this.app.addStrokePoint(this.screenToWorld(x, y));
        break;
      case 'tap': {
        const ddy = y - g.start[1];
        if (!g.moved && Math.hypot(x - g.start[0], ddy) < MOVE_THRESHOLD) break;
        g.moved = true;
        // Полное движение по окну сверху вниз — весь объём, как в Vidi Web.
        const { n } = this.basis();
        const per = extentAlong(n, this.s.size) / Math.max(1, this.H * 0.9);
        this.setCrosshair(addScaled(g.from, n, ddy * per));
        break;
      }
      case 'measure':
        if (Math.hypot(x - g.start[0], y - g.start[1]) > 6) g.moved = true;
        this.app.measureHover(this, this.screenToWorld(x, y));
        break;
      default:
        break;
    }
  }

  _up(e, cancelled = false) {
    const el = this.surface;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) this.gesture = null;
      // Оставшийся палец не должен сразу двигать перекрестие.
      return;
    }
    if (this.pointers.size > 0) return;
    if (g.kind === 'measure' && !cancelled) {
      const [x, y] = this._local(e);
      this.app.measurePointerUp(this, this.screenToWorld(x, y), g.moved);
    }
    if (g.kind === 'pencil') {
      if (cancelled) this.app.cancelDraft();
      else this.app.endStroke();
    }
    if (g.kind === 'tap' && !g.moved && !cancelled) {
      const p = this.screenToWorld(...this._local(e));
      if (this.s.tool === 'ruler' || this.s.tool === 'angle') this.app.measurePointerDown(this, p);
      else this.setCrosshair(p);
    }
    this.gesture = null;
    if (g.kind === 'rotate') this.app.invalidate();
  }
}
