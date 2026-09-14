// Веб-демо Vidi: загрузка демонстрационного КЛКТ, раскладка пейнов, тулбары, цикл кадра.

import { Renderer } from './renderer.js';
import { fetchManifest, fetchLevel } from './loader.js';
import { MprPane, PLANE_KEYS } from './mpr.js';
import { VolumePane, VIEWS, CLIP_AXES } from './view3d.js';
import { TRANSFER_FUNCTIONS, VOLUME_MODES, WINDOW_PRESETS, bakeLUT } from './presets.js';
import { dot, sub, len, I3, scale } from './vec.js';

// Текущее исследование. Прежние сборки остались рядом: data/ — демо-КЛКТ из VidiDemo.app,
// data/v2/ — это же КТ с обрезкой на 3000 (засвечено). Вернуть любую — поменять путь.
const DATA_BASE = new URL('../data/v3/', import.meta.url).href;
// Шрифты дизайн-системы (Golos Text, Inter, JetBrains Mono) — без блокировки первого кадра.
{
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Golos+Text:wght@800;900&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
  document.head.appendChild(l);
}

const MOBILE_QUERY = '(max-width: 760px)';
const HINT_KEY = 'vidi-demo-hint-closed';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(1)} МБ`; // десятичная точка — как в приложении и дизайн-системе

const FEATURES = {
  own: {
    title: 'Свои снимки — в Vidi для Mac',
    img: '../assets/app-main.webp',
    text: 'Перетащите архив ZIP или RAR с КЛКТ в окно Vidi — приложение само найдёт исследование внутри. Снимки открываются локально на вашем Mac, в интернет они не загружаются.',
  },
  pano: {
    title: 'Панорама из КЛКТ',
    img: '../assets/panorama.webp',
    text: 'Привычная панорама вдоль зубной дуги строится прямо из КЛКТ — рядом с тремя проекциями.',
  },
  canal: {
    title: 'Разметка нижнечелюстного канала',
    img: '../assets/implant-safety.webp',
    text: 'Канал размечается в несколько кликов: автоматическая трассировка и ручная коррекция точек.',
  },
  implant: {
    title: 'Планирование имплантации',
    img: '../assets/implant-safety.webp',
    text: 'Имплант ставится в проекциях и в 3D, а расстояние до канала видно сразу.',
  },
  report: {
    title: 'PDF-отчёт',
    img: '../assets/report.webp',
    text: 'Понятный PDF-отчёт из исследования: срезы по выбранному зубу, реквизиты клиники и врача.',
  },
};

class App {
  constructor() {
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    this.mobile = matchMedia(MOBILE_QUERY);
    this.viewer = $('#viewer');
    this.panesEl = $('#panes');
    this.canvas = $('#gl');
    this.ready = false;
    this.state = null;
    this.raf = 0;
    this.dirty3D = true;
    this.last3DKey = '';
    this.hd = 'idle';
  }

  // ------------------------------------------------------------ boot

  async start() {
    document.documentElement.classList.toggle('is-touch', this.isTouch);
    this.bindChrome();
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (err) {
      console.error(err);
      this.fatal('webgl');
      return;
    }
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fatal('lost');
    });

    try {
      this.manifest = await fetchManifest(DATA_BASE);
      const lo = this.manifest.levels.find((l) => l.name === 'lo');
      $('#loader-size').textContent = fmtMB(lo.bytes);
      const bytes = await fetchLevel(DATA_BASE, lo, (p) => this.progress(p));
      this.initState(lo);
      this.renderer.setVolume(bytes, lo.dims);
      this.level = lo;
    } catch (err) {
      console.error(err);
      this.fatal(err.message === 'no-decompression-stream' ? 'browser' : 'network');
      return;
    }

    this.panes = {};
    for (const key of PLANE_KEYS) this.panes[key] = new MprPane(this, $(`.pane[data-pane="${key}"]`), key);
    this.volumePane = new VolumePane(this, $('.pane[data-pane="volume"]'));
    this.setVolumeMode(this.state.three.mode);
    this.bindViewer();
    this.applyLayout();

    new ResizeObserver(() => this.invalidate3D()).observe(this.viewer);
    this.mobile.addEventListener('change', () => this.applyLayout());

    this.ready = true;
    this.viewer.classList.add('is-ready');
    $('#loader').hidden = true;
    let hintClosed = false;
    try { hintClosed = localStorage.getItem(HINT_KEY) === '1'; } catch { /* приватный режим */ }
    $('#hint').hidden = hintClosed;
    this.invalidate3D();
    this.updateHDButton();
    if (this.shouldAutoHD()) this.loadHD();
  }

  initState(level) {
    const size = level.dims.map((d, i) => d * level.spacing[i]);
    const initial = this.manifest.initial?.crosshair || scale(size, 0.5);
    // Как в приложении (SliceRenderer.defaultWindow): по умолчанию окно из тегов снимка.
    const dicomWindow = this.manifest.window;
    this.windowPresets = dicomWindow
      ? [{ id: 'dicom', label: 'Как в снимке', center: dicomWindow.center, width: dicomWindow.width }, ...WINDOW_PRESETS]
      : WINDOW_PRESETS;
    this.state = {
      size,
      huMin: this.manifest.huMin,
      huMax: this.manifest.huMax,
      initial,
      crosshair: [...initial],
      R: I3(),
      centers: { axial: [...initial], sagittal: [...initial], coronal: [...initial] },
      zoom: { axial: 1, sagittal: 1, coronal: 1 },
      window: { center: this.windowPresets[0].center, width: this.windowPresets[0].width },
      thick: 0,
      tool: 'nav',
      measurements: [],
      draft: null,
      layout: 'grid',
      focus: 'axial',
      three: {
        mode: 'teeth',
        lastView: 'front',
        clip: { on: false, axis: 'y', pos: 0.5, flip: false },
      },
    };
  }

  progress(p) {
    const pct = Math.round(p * 100);
    $('#loader-bar').style.transform = `scaleX(${p})`;
    $('#loader-pct').textContent = `${pct} %`;
  }

  fatal(kind) {
    const card = $('#loader');
    card.hidden = false;
    card.classList.add('is-error');
    const messages = {
      webgl: ['Браузер не поддерживает WebGL 2', 'Без него объёмный просмотр КЛКТ не запустится. Откройте страницу в актуальном Safari, Chrome или Firefox.'],
      browser: ['Браузер устарел', 'Для распаковки снимка нужен Safari 16.4+, Chrome 80+ или Firefox 113+.'],
      network: ['Снимок не загрузился', 'Проверьте соединение и попробуйте ещё раз.'],
      lost: ['Видеокарта сбросила контекст', 'Так бывает при нехватке памяти. Перезагрузите страницу.'],
    };
    const [title, text] = messages[kind];
    $('#loader-title').textContent = title;
    $('#loader-text').textContent = text;
    $('#loader-text').hidden = false;
    $('#loader-progress').hidden = true;
    $('#loader-retry').hidden = kind === 'webgl' || kind === 'browser';
  }

  shouldAutoHD() {
    const conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return false;
    return !this.isTouch && window.innerWidth >= 1024 && this.renderer.maxTexture3D >= 400;
  }

  async loadHD() {
    const hi = this.manifest.levels.find((l) => l.name === 'hi');
    if (!hi || this.hd === 'loading' || this.hd === 'done') return;
    if (this.renderer.maxTexture3D < Math.max(...hi.dims)) return;
    this.hd = 'loading';
    this.hdProgress = 0;
    this.updateHDButton();
    try {
      const bytes = await fetchLevel(DATA_BASE, hi, (p) => {
        this.hdProgress = p;
        this.updateHDButton();
      });
      this.renderer.setVolume(bytes, hi.dims);
      this.level = hi;
      this.state.size = hi.dims.map((d, i) => d * hi.spacing[i]);
      this.hd = 'done';
      this.invalidate3D();
    } catch (err) {
      console.error(err);
      this.hd = 'error';
    }
    this.updateHDButton();
  }

  updateHDButton() {
    const btn = $('#hd-btn');
    if (!btn || !this.manifest) return;
    const hi = this.manifest.levels.find((l) => l.name === 'hi');
    const label = $('.hd-label', btn);
    btn.dataset.state = this.hd;
    btn.disabled = this.hd === 'loading' || this.hd === 'done';
    if (this.hd === 'idle') {
      label.textContent = `HD · ${fmtMB(hi.bytes)}`;
      btn.title = 'Загрузить снимок в высоком разрешении (0.4 мм)';
    } else if (this.hd === 'loading') {
      label.textContent = `HD ${Math.round(this.hdProgress * 100)} %`;
      btn.title = 'Загружается снимок в высоком разрешении';
    } else if (this.hd === 'done') {
      label.textContent = 'HD';
      btn.title = 'Снимок в высоком разрешении (0.4 мм)';
    } else {
      label.textContent = 'HD — повторить';
      btn.disabled = false;
      this.hd = 'idle';
    }
  }

  // ------------------------------------------------------------ render loop

  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  invalidate3D() {
    this.dirty3D = true;
    this.invalidate();
  }

  frame() {
    this.raf = 0;
    if (!this.ready) return;
    const r = this.renderer;
    const vr = this.viewer.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    r.resize(Math.max(1, Math.round(vr.width * dpr)), Math.max(1, Math.round(vr.height * dpr)));
    r.clear();

    const rectOf = (pane) => {
      const b = pane.surface.getBoundingClientRect();
      pane.W = b.width;
      pane.H = b.height;
      return {
        x: Math.round((b.left - vr.left) * dpr),
        y: Math.round((b.top - vr.top) * dpr),
        w: Math.round(b.width * dpr),
        h: Math.round(b.height * dpr),
      };
    };

    for (const key of PLANE_KEYS) {
      const pane = this.panes[key];
      const rect = rectOf(pane);
      if (rect.w <= 0 || rect.h <= 0) continue;
      r.drawMPR(rect, pane.glParams(this.level));
      pane.renderOverlay();
    }

    const vp = this.volumePane;
    const rect = rectOf(vp);
    if (rect.w > 0 && rect.h > 0) {
      const [w, h] = vp.renderSize();
      const key = `${w}x${h}`;
      if (this.dirty3D || key !== this.last3DKey) {
        r.renderVolume(w, h, vp.params(this.level));
        this.last3DKey = key;
        this.dirty3D = false;
      }
      r.blitVolume(rect);
      vp.renderOverlay();
    }
  }

  // ------------------------------------------------------------ state actions

  focusPane(key) {
    this.state.focus = key;
    $$('.pane', this.panesEl).forEach((p) => p.classList.toggle('is-focus', p.dataset.pane === key));
    $$('[data-pane-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.paneTab === key)));
  }

  setLayout(layout, focus) {
    if (focus) this.focusPane(focus);
    this.state.layout = layout;
    this.applyLayout();
  }

  applyLayout() {
    const st = this.state;
    if (!st) return;
    const single = this.mobile.matches || st.layout === 'single';
    this.panesEl.dataset.layout = single ? 'single' : 'grid';
    this.focusPane(st.focus);
    const btn = $('#layout-btn');
    if (btn) btn.setAttribute('aria-pressed', String(st.layout === 'single'));
    this.invalidate3D();
  }

  setTool(tool) {
    this.state.tool = tool;
    this.state.draft = null;
    $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    this.panesEl.dataset.activeTool = tool;
    this.invalidate();
  }

  setWindow(center, width) {
    this.state.window = { center, width };
    $$('[data-window]').forEach((b) => {
      const p = this.windowPresets.find((w) => w.id === b.dataset.window);
      b.setAttribute('aria-pressed', String(!!p && p.center === center && p.width === width));
    });
    this.invalidate();
  }

  setThickness(mm) {
    this.state.thick = mm;
    $$('[data-thick]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.thick) === mm)));
    $('#thick-value').textContent = mm ? `MIP ${mm} мм` : 'Срез';
    this.invalidate();
  }

  setVolumeMode(mode) {
    this.state.three.mode = mode;
    const tf = TRANSFER_FUNCTIONS[mode === 'xray' ? 'bone' : mode];
    this.renderer.setLUT(bakeLUT(tf));
    const sel = $('#vol-mode');
    if (sel) sel.value = mode;
    this.invalidate3D();
  }

  resetView() {
    const st = this.state;
    st.crosshair = [...st.initial];
    st.R = I3();
    for (const k of PLANE_KEYS) {
      st.centers[k] = [...st.initial];
      st.zoom[k] = 1;
    }
    this.setWindow(this.windowPresets[0].center, this.windowPresets[0].width);
    this.setThickness(0);
    st.draft = null;
    this.volumePane.setView('front');
    st.three.lastView = 'front';
    this.invalidate3D();
  }

  // ------------------------------------------------------------ measurements

  visibleMeasurements(pane) {
    const st = this.state;
    const { n } = pane.basis();
    const tol = Math.max(...this.level.spacing) * 0.75 + st.thick / 2;
    return st.measurements.filter((m) => m.plane === pane.plane
      && Math.abs(dot(m.n, n)) > 0.999
      && Math.abs(dot(sub(m.pts[0], st.crosshair), n)) <= tol);
  }

  measurePointerDown(pane, p) {
    const st = this.state;
    if (st.draft && st.draft.plane !== pane.plane) st.draft = null;
    const need = st.tool === 'ruler' ? 2 : 3;
    if (!st.draft) {
      st.draft = { type: need === 2 ? 'dist' : 'angle', plane: pane.plane, n: pane.basis().n, pts: [p, [...p]], need };
    } else {
      this._placeDraftPoint(p);
    }
    this.invalidate();
  }

  measureHover(pane, p) {
    const d = this.state.draft;
    if (!d || d.plane !== pane.plane) return;
    d.pts[d.pts.length - 1] = p;
    this.invalidate();
  }

  measurePointerUp(pane, p, moved) {
    const d = this.state.draft;
    if (!d || d.plane !== pane.plane || !moved) return;
    this._placeDraftPoint(p);
    this.invalidate();
  }

  _placeDraftPoint(p) {
    const d = this.state.draft;
    const i = d.pts.length - 1;
    d.pts[i] = p;
    if (len(sub(d.pts[i], d.pts[i - 1])) < 0.3) return;
    if (d.pts.length === d.need) {
      this.state.measurements.push({ type: d.type, plane: d.plane, n: d.n, pts: d.pts });
      this.state.draft = null;
      $('#clear-btn').disabled = false;
    } else {
      d.pts.push([...p]);
    }
  }

  cancelDraft() {
    this.state.draft = null;
    this.invalidate();
  }

  clearMeasurements() {
    this.state.measurements = [];
    this.state.draft = null;
    $('#clear-btn').disabled = true;
    this.invalidate();
  }

  // ------------------------------------------------------------ UI wiring

  bindChrome() {
    // Диалог «только в приложении».
    const dlg = $('#feature-dialog');
    $$('[data-feature]').forEach((b) => b.addEventListener('click', () => this.openFeature(b.dataset.feature)));
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

    const help = $('#help-dialog');
    $$('[data-help]').forEach((b) => b.addEventListener('click', () => {
      this.closePops();
      help.showModal();
    }));
    $$('[data-close]', help).forEach((b) => b.addEventListener('click', () => help.close()));
    help.addEventListener('click', (e) => { if (e.target === help) help.close(); });

    // Всплывающие меню.
    $$('[data-pop]').forEach((btn) => {
      const pop = document.getElementById(btn.dataset.pop);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = pop.hidden;
        this.closePops();
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });
      pop.addEventListener('click', (e) => e.stopPropagation());
    });
    document.addEventListener('click', () => this.closePops());

    $('#loader-retry').addEventListener('click', () => location.reload());

    const hint = $('#hint');
    $('#hint-close').addEventListener('click', () => {
      hint.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* приватный режим */ }
    });
  }

  closePops() {
    $$('[data-pop]').forEach((btn) => {
      document.getElementById(btn.dataset.pop).hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  openFeature(key) {
    const f = FEATURES[key];
    const dlg = $('#feature-dialog');
    $('#feature-title').textContent = f.title;
    $('#feature-text').textContent = f.text;
    const img = $('#feature-img');
    img.src = f.img;
    img.alt = f.title;
    this.closePops();
    dlg.showModal();
  }

  bindViewer() {
    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    $$('[data-window]').forEach((b) => {
      b.hidden = !this.windowPresets.some((w) => w.id === b.dataset.window);
    });
    $$('[data-window]').forEach((b) => b.addEventListener('click', () => {
      const p = this.windowPresets.find((w) => w.id === b.dataset.window);
      this.setWindow(p.center, p.width);
    }));
    $$('[data-thick]').forEach((b) => b.addEventListener('click', () => this.setThickness(Number(b.dataset.thick))));
    $('#clear-btn').addEventListener('click', () => this.clearMeasurements());
    $('#reset-btn').addEventListener('click', () => this.resetView());
    $$('[data-action]').forEach((b) => b.addEventListener('click', () => {
      this.closePops();
      if (b.dataset.action === 'reset') this.resetView();
      else this.clearMeasurements();
    }));
    $('#layout-btn').addEventListener('click', () => {
      this.setLayout(this.state.layout === 'single' ? 'grid' : 'single');
    });
    $('#hd-btn').addEventListener('click', () => this.loadHD());

    $$('.pane-title').forEach((b) => b.addEventListener('click', () => {
      const key = b.closest('.pane').dataset.pane;
      const single = this.state.layout === 'single' && this.state.focus === key;
      this.setLayout(single ? 'grid' : 'single', key);
    }));
    $$('[data-pane-tab]').forEach((b) => b.addEventListener('click', () => {
      this.focusPane(b.dataset.paneTab);
      this.invalidate3D();
    }));

    // 3D-тулбар.
    const modeSel = $('#vol-mode');
    modeSel.innerHTML = VOLUME_MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
    modeSel.value = this.state.three.mode;
    modeSel.addEventListener('change', () => this.setVolumeMode(modeSel.value));

    const viewsPop = $('#views-pop');
    viewsPop.innerHTML = Object.entries(VIEWS)
      .map(([k, v]) => `<button type="button" class="pop-item" data-view="${k}">${v.label}</button>`).join('');
    $$('[data-view]', viewsPop).forEach((b) => b.addEventListener('click', () => {
      this.state.three.lastView = b.dataset.view;
      this.volumePane.setView(b.dataset.view);
      this.closePops();
    }));

    const clip = this.state.three.clip;
    const clipBtn = $('#clip-btn');
    const axisSel = $('#clip-axis');
    const range = $('#clip-range');
    const rangeOut = $('#clip-value');
    const flip = $('#clip-flip');
    axisSel.innerHTML = Object.entries(CLIP_AXES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    const syncClip = () => {
      clipBtn.setAttribute('aria-pressed', String(clip.on));
      axisSel.value = clip.axis;
      range.value = String(Math.round(clip.pos * 100));
      rangeOut.textContent = `${Math.round(clip.pos * 100)} %`;
      $('.vol-clip', this.viewer).classList.toggle('is-on', clip.on);
      this.invalidate3D();
    };
    clipBtn.addEventListener('click', () => { clip.on = !clip.on; syncClip(); });
    axisSel.addEventListener('change', () => { clip.axis = axisSel.value; clip.on = true; syncClip(); });
    range.addEventListener('input', () => {
      clip.pos = Number(range.value) / 100;
      clip.on = true;
      this.volumePane.beginInteraction();
      syncClip();
    });
    range.addEventListener('change', () => this.volumePane.endInteraction());
    flip.addEventListener('click', () => { clip.flip = !clip.flip; clip.on = true; syncClip(); });
    $('#vol-reset').addEventListener('click', () => {
      this.state.three.lastView = 'front';
      this.volumePane.setView('front');
    });
    syncClip();

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') this.cancelDraft();
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        this.state.measurements.pop();
        $('#clear-btn').disabled = this.state.measurements.length === 0;
        this.invalidate();
      } else if (e.key === 'v' || e.key === 'V') this.setTool('nav');
      else if (e.key === 'm' || e.key === 'M') this.setTool('ruler');
      else if (e.key === 'a' || e.key === 'A') this.setTool('angle');
    });

    this.setTool('nav');
    this.setWindow(this.state.window.center, this.state.window.width);
    this.setThickness(0);
  }
}

const app = new App();
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.vidiDemo = app;
app.start();
