// 3D-пейн: ортографическая камера и управление как в Volume3DView приложения.

import { add, sub, scale, dot, cross, norm, len, mulV, axisAngle, clamp, capturePointer } from './vec.js';
import { sideLetter, extentAlong } from './mpr.js';
import { TRANSFER_FUNCTIONS } from './presets.js';

export const VIEWS = {
  front: { label: 'Спереди', fwd: [0, 1, 0], up: [0, 0, 1] },
  back: { label: 'Сзади', fwd: [0, -1, 0], up: [0, 0, 1] },
  right: { label: 'Справа', fwd: [1, 0, 0], up: [0, 0, 1] },
  left: { label: 'Слева', fwd: [-1, 0, 0], up: [0, 0, 1] },
  top: { label: 'Сверху', fwd: [0, 0, -1], up: [0, -1, 0] },
  bottom: { label: 'Снизу', fwd: [0, 0, 1], up: [0, -1, 0] },
};

export const CLIP_AXES = {
  x: { label: 'X (Sagittal)', index: 0 },
  y: { label: 'Y (Coronal)', index: 1 },
  z: { label: 'Z (Axial)', index: 2 },
};

const XRAY_WINDOW = { center: 2707, width: 3048 };

export class VolumePane {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.surface = el.querySelector('.pane-surface');
    this.svg = el.querySelector('.pane-ov');
    this.W = 1;
    this.H = 1;
    this.pointers = new Map();
    this.gesture = null;
    this.interacting = false;
    this.idleTimer = 0;
    this.setView('front', false);
    this._bind();
  }

  get s() {
    return this.app.state.three;
  }

  setView(key, animate = true) {
    const v = VIEWS[key];
    const st = this.app.state.three;
    const target = { fwd: norm(v.fwd), up: norm(v.up) };
    target.right = norm(cross(target.fwd, target.up));
    const size = this.app.state.size;
    // Масштаб «вписать» считаем один раз для вида: при вращении картинка не прыгает.
    st.fit = { u: extentAlong(target.right, size), v: extentAlong(target.up, size) };
    st.zoom = 1;
    st.pan = [0, 0];
    if (!animate || !st.fwd) {
      Object.assign(st, target);
      this.app.invalidate3D();
      return;
    }
    const from = { fwd: st.fwd, up: st.up };
    const t0 = performance.now();
    const dur = 320;
    const step = (now) => {
      const k = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const fwd = norm(add(scale(from.fwd, 1 - e), scale(target.fwd, e)));
      let up = add(scale(from.up, 1 - e), scale(target.up, e));
      if (len(up) < 1e-3 || len(fwd) < 1e-3) {
        Object.assign(st, target);
      } else {
        up = norm(sub(up, scale(fwd, dot(up, fwd))));
        st.fwd = fwd;
        st.up = up;
        st.right = norm(cross(fwd, up));
      }
      this.beginInteraction();
      if (k < 1) requestAnimationFrame(step);
      else {
        Object.assign(st, target);
        this.endInteraction();
      }
    };
    requestAnimationFrame(step);
  }

  beginInteraction() {
    this.interacting = true;
    clearTimeout(this.idleTimer);
    this.app.invalidate3D();
  }

  endInteraction() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.interacting = false;
      this.app.invalidate3D();
    }, 160);
  }

  params(level) {
    const app = this.app.state;
    const st = this.s;
    const size = app.size;
    const aspect = this.W / Math.max(1, this.H);
    const halfH = (Math.max(st.fit.v / 2, st.fit.u / 2 / aspect) * 1.12) / st.zoom;
    const halfW = halfH * aspect;
    const center = scale(size, 0.5);
    const dist = len(size);
    const range = app.huMax - app.huMin;
    const mode = st.mode;
    const tf = TRANSFER_FUNCTIONS[mode === 'xray' ? 'bone' : mode];
    const step = this.interacting ? 1.0 : 0.5;
    const clipAxis = CLIP_AXES[st.clip.axis].index;
    const clipO = [...center];
    clipO[clipAxis] = size[clipAxis] * st.clip.pos;
    const clipN = [0, 0, 0];
    clipN[clipAxis] = st.clip.flip ? -1 : 1;
    return {
      camPos: sub(center, scale(st.fwd, dist)),
      right: scale(st.right, halfW),
      up: scale(st.up, halfH),
      fwd: st.fwd,
      pan: st.pan,
      size,
      gradStep: level.dims.map((d) => 1.5 / d),
      step,
      maxSteps: Math.min(2048, Math.ceil((dist * 2) / step) + 2),
      opacity: 1.5,
      huScale: range,
      huOffset: app.huMin,
      tfMin: tf.huMin,
      tfInvRange: 1 / (tf.huMax - tf.huMin),
      ambient: 0.25,
      lightAz: 1.043,
      clip: st.clip.on,
      clipO,
      clipN,
      xray: mode === 'xray',
      xrayLo: XRAY_WINDOW.center - XRAY_WINDOW.width / 2,
      xrayInvW: 1 / XRAY_WINDOW.width,
    };
  }

  /** Размер offscreen-рендера: при вращении — грубее, в покое — чётко. */
  renderSize() {
    const dpr = window.devicePixelRatio || 1;
    const q = this.interacting ? (this.app.isTouch ? 0.6 : 1) : Math.min(dpr, this.app.isTouch ? 1.5 : 1.75);
    return [Math.max(1, Math.round(this.W * q)), Math.max(1, Math.round(this.H * q))];
  }

  renderOverlay() {
    const st = this.s;
    const W = this.W, H = this.H;
    const t = (x, y, s, a) => `<text x="${x}" y="${y}" class="ov-side" text-anchor="${a}" dominant-baseline="middle">${s}</text>`;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.innerHTML = [
      t(12, H / 2, sideLetter(scale(st.right, -1)), 'start'),
      t(W - 12, H / 2, sideLetter(st.right), 'end'),
      t(W / 2, 40, sideLetter(st.up), 'middle'),
      t(W / 2, H - 70, sideLetter(scale(st.up, -1)), 'middle'),
    ].join('');
  }

  rotateBy(dx, dy) {
    const st = this.s;
    const k = 0.008;
    if (dx) {
      const m = axisAngle(st.up, -dx * k);
      st.fwd = mulV(m, st.fwd);
      st.right = mulV(m, st.right);
    }
    if (dy) {
      const m = axisAngle(st.right, -dy * k);
      st.fwd = mulV(m, st.fwd);
      st.up = mulV(m, st.up);
    }
    st.fwd = norm(st.fwd);
    st.up = norm(sub(st.up, scale(st.fwd, dot(st.up, st.fwd))));
    st.right = norm(cross(st.fwd, st.up));
  }

  zoomAt(factor, x, y) {
    const st = this.s;
    const next = clamp(st.zoom * factor, 0.4, 12);
    const f = next / st.zoom;
    // Точка под курсором остаётся на месте.
    const nx = (x / this.W) * 2 - 1;
    const ny = 1 - (y / this.H) * 2;
    st.pan = [(st.pan[0] + nx) * f - nx, (st.pan[1] + ny) * f - ny];
    st.zoom = next;
  }

  _local(e) {
    const r = this.surface.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _bind() {
    const el = this.surface;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (!this.app.ready) return;
      e.preventDefault();
      const [x, y] = this._local(e);
      const unit = e.deltaMode === 1 ? 0.05 : 0.0025;
      this.zoomAt(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 4 : 1)), x, y);
      this.beginInteraction();
      this.endInteraction();
    }, { passive: false });

    el.addEventListener('dblclick', () => this.setView(this.app.state.three.lastView || 'front'));

    if (!this.app.isTouch) {
      let last = 1;
      el.addEventListener('gesturestart', (e) => { e.preventDefault(); last = 1; });
      el.addEventListener('gesturechange', (e) => {
        e.preventDefault();
        const [x, y] = this._local(e);
        this.zoomAt(e.scale / last, x, y);
        last = e.scale;
        this.beginInteraction();
        this.endInteraction();
      });
    }

    el.addEventListener('pointerdown', (e) => {
      if (!this.app.ready) return;
      capturePointer(el, e.pointerId);
      const [x, y] = this._local(e);
      this.pointers.set(e.pointerId, { x, y });
      this.app.focusPane('volume');
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
      } else if (this.pointers.size === 1) {
        const pan = e.button === 1 || e.button === 2 || (e.shiftKey && e.pointerType === 'mouse');
        this.gesture = { kind: pan ? 'pan' : 'rotate' };
      }
      this.beginInteraction();
    });

    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p || !this.gesture) return;
      const [x, y] = this._local(e);
      const g = this.gesture;
      if (g.kind === 'idle') {
        // Палец, оставшийся после пинча, не должен рывком вращать объём.
        p.x = x; p.y = y;
        return;
      }
      if (g.kind === 'pinch') {
        p.x = x; p.y = y;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const st = this.s;
        st.pan = [st.pan[0] - ((mid[0] - g.mid[0]) / this.W) * 2, st.pan[1] + ((mid[1] - g.mid[1]) / this.H) * 2];
        if (g.dist > 10) this.zoomAt(dist / g.dist, mid[0], mid[1]);
        g.dist = dist;
        g.mid = mid;
      } else {
        const dx = x - p.x, dy = y - p.y;
        p.x = x; p.y = y;
        if (g.kind === 'rotate') this.rotateBy(dx, dy);
        else {
          const st = this.s;
          st.pan = [st.pan[0] - (dx / this.W) * 2, st.pan[1] + (dy / this.H) * 2];
        }
      }
      this.beginInteraction();
    });

    const up = (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.gesture = null;
      else if (this.gesture && this.gesture.kind === 'pinch') this.gesture = { kind: 'idle' };
      this.endInteraction();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
