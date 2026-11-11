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

// Граница телефона — как в Vidi Web.
const MOBILE_QUERY = '(max-width: 720px)';

// Подписи кнопок бара в окне «?» — как в Vidi Web (`app.js`, TOOL_HELP).
const TOOL_HELP = {
  layout: 'Одна проекция во весь экран или три сразу: выбранная вкладкой — крупно сверху, две другие под ней.',
  window: 'Яркость и контраст: ведите по снимку вправо — шире окно, вверх — светлее.',
  slab: 'Толщина слоя: 0 → 3 → 5 → 10 → 20 мм. В толстом слое видно самое плотное.',
  ruler: 'Два касания — расстояние в миллиметрах.',
  angle: 'Три касания — угол, вершина во второй точке.',
  pencil: 'Рисуйте по срезу. Линия видна только на своём срезе.',
  erase: 'Убрать измерения и линии. Нажмите дважды: первое нажатие взводит кнопку.',
  reset: 'Вернуть увеличение, сдвиг, наклон и окно. Разметку не трогает.',
};
const SLAB_STEPS = [0, 3, 5, 10, 20];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(1)} МБ`; // десятичная точка — как в приложении и дизайн-системе

const FEATURES = {
  own: {
    title: 'Свои DICOM-файлы — в Vidi для Mac',
    img: '../assets/app-main.webp',
    text: 'Перетащите архив ZIP или RAR с КЛКТ в окно Vidi для ознакомительного просмотра или демонстрации — приложение само найдёт исследование внутри. Файлы открываются локально на вашем Mac, в интернет они не загружаются.',
  },
  pano: {
    title: 'Панорама из КЛКТ',
    img: '../assets/panorama.webp',
    text: 'Панорамная развёртка вдоль зубной дуги строится из КЛКТ — рядом с тремя проекциями. Используется для учебных иллюстраций и демонстрации.',
  },
  canal: {
    title: 'Демонстрационная разметка канала',
    img: '../assets/implant-safety.webp',
    text: 'Автоматическая трассировка и ручная коррекция точек создают разметку нижнечелюстного канала для демонстрации его геометрии.',
  },
  implant: {
    title: 'Виртуальные модели имплантов',
    img: '../assets/implant-safety.webp',
    text: 'Виртуальная модель импланта отображается в проекциях и 3D; расстояние до размеченного канала показано как геометрическое измерение для демонстрации. Не предназначено для планирования лечения.',
  },
  report: {
    title: 'PDF-иллюстрации',
    img: null,
    text: 'Экспорт изображений, срезов и таблиц измерений в PDF для учебных иллюстраций и демонстрации. PDF может содержать данные исследования; он не является диагностическим заключением или планом лечения.',
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
    this.invalidate3D();
    // Снимок 0.4 мм догружается сам и на телефоне: 7 МБ — как одна фотография.
    // Кнопки «HD» больше нет — в Vidi Web её тоже нет.
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
      layoutChoice: null, // 'one' | 'three'; null — по ширине экрана, как в Vidi Web
      focus: 'axial',
      main: 'axial',      // последняя проекция среза — к ней «3» вернётся из 3D
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
    return this.renderer.maxTexture3D >= 400;
  }

  async loadHD() {
    const hi = this.manifest.levels.find((l) => l.name === 'hi');
    if (!hi || this.hd === 'loading' || this.hd === 'done') return;
    if (this.renderer.maxTexture3D < Math.max(...hi.dims)) return;
    this.hd = 'loading';
    try {
      const bytes = await fetchLevel(DATA_BASE, hi, () => {});
      this.renderer.setVolume(bytes, hi.dims);
      this.level = hi;
      this.state.size = hi.dims.map((d, i) => d * hi.spacing[i]);
      this.hd = 'done';
      this.invalidate3D();
    } catch (err) {
      console.error(err);
      this.hd = 'error';
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

  // Раскладка — как в Vidi Web (`viewer.js`, applyLayout): «1» или «3»; на телефоне
  // «3» — выбранная проекция сверху, две другие под ней, как в приложении для iPhone.

  narrow() {
    return this.mobile.matches;
  }

  currentLayout() {
    return this.state.layoutChoice ?? (this.narrow() ? 'one' : 'three');
  }

  /** Что на экране на самом деле: на телефоне в «3» вкладка «3D» показывает объём во весь экран. */
  shownLayout() {
    const mode = this.currentLayout();
    return mode === 'three' && this.narrow() && this.state.focus === 'volume' ? 'one' : mode;
  }

  focusPane(key) {
    this.state.focus = key;
    if (key !== 'volume') this.state.main = key;
    $$('.pane', this.panesEl).forEach((p) => p.classList.toggle('is-focus', p.dataset.pane === key));
    $$('[data-pane-tab]').forEach((b) => {
      const on = b.dataset.paneTab === key;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  /** Касание окна. На телефоне в «3» главную выбирает только вкладка: касание малого окна их не переставляет. */
  touchPane(key) {
    if (this.narrow() && this.shownLayout() === 'three') return;
    if (this.state.focus !== key) this.focusPane(key);
  }

  selectPane(key) {
    this.focusPane(key);
    this.applyLayout();
  }

  toggleLayout() {
    const st = this.state;
    if (this.shownLayout() === 'one') {
      st.layoutChoice = 'three';
      // Из 3D — к последней проекции среза: объёма среди трёх проекций на телефоне нет.
      if (this.narrow() && st.focus === 'volume') this.focusPane(st.main);
    } else {
      st.layoutChoice = 'one';
    }
    this.applyLayout();
  }

  applyLayout() {
    const st = this.state;
    if (!st) return;
    const shown = this.shownLayout();
    this.panesEl.dataset.layout = shown === 'one' ? 'single' : (this.narrow() ? 'three' : 'grid');
    document.body.classList.toggle('layout-one', shown === 'one');
    document.body.classList.toggle('layout-three', shown === 'three');
    this.focusPane(st.focus);
    const btn = $('.tool[data-tool="layout"]');
    if (btn) {
      const target = shown === 'one' ? 'three' : 'one';
      btn.dataset.target = target;
      btn.setAttribute('aria-label', target === 'three' ? 'Три проекции' : 'Одна проекция');
    }
    this.invalidate3D();
  }

  /** Кнопка бара: инструмент включается и выключается повторным нажатием, как в Vidi Web. */
  useTool(name) {
    if (!this.ready) return;
    if (name !== 'erase') this.disarmErase();
    if (name === 'layout') { this.toggleLayout(); return; }
    if (name === 'reset') { this.resetView(); return; }
    if (name === 'slab') {
      const at = SLAB_STEPS.indexOf(this.state.thick);
      this.setThickness(SLAB_STEPS[(at + 1) % SLAB_STEPS.length]);
      return;
    }
    if (name === 'erase') { this.armErase(); return; }
    this.setTool(this.state.tool === name ? 'nav' : name);
  }

  setTool(tool) {
    this.state.tool = tool;
    this.state.draft = null;
    this.panesEl.dataset.activeTool = tool;
    this.updateTools();
    this.invalidate();
  }

  hasMarkup() {
    return this.state.measurements.length > 0 || !!this.state.draft;
  }

  updateTools() {
    const st = this.state;
    for (const b of $$('.tool')) {
      const name = b.dataset.tool;
      if (name === 'erase') {
        b.disabled = !this.hasMarkup();
        b.classList.toggle('is-armed', !b.disabled && !!this.eraseArmed);
        b.setAttribute('aria-label', this.eraseArmed ? 'Стереть разметку — нажмите ещё раз' : 'Стереть разметку');
      } else if (name === 'slab') {
        $('.mm', b).textContent = st.thick ? String(st.thick) : '';
        b.setAttribute('aria-label', st.thick ? `Толщина слоя ${st.thick} мм` : 'Толщина слоя');
      } else if (['window', 'ruler', 'angle', 'pencil'].includes(name)) {
        b.classList.toggle('is-active', st.tool === name);
        b.setAttribute('aria-pressed', String(st.tool === name));
      }
    }
  }

  /*
    Удаление разметки — как в Vidi Web: первое нажатие взводит кнопку, второе стирает,
    через четыре секунды кнопка сама возвращается в исходное.
  */
  armErase() {
    clearTimeout(this.eraseTimer);
    if (this.eraseArmed) {
      this.eraseArmed = false;
      this.clearMeasurements();
      return;
    }
    if (!this.hasMarkup()) return;
    this.eraseArmed = true;
    this.eraseTimer = setTimeout(() => this.disarmErase(), 4000);
    this.updateTools();
  }

  disarmErase() {
    clearTimeout(this.eraseTimer);
    if (!this.eraseArmed) return;
    this.eraseArmed = false;
    this.updateTools();
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
    this.updateTools();
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
      this.updateTools();
    } else {
      d.pts.push([...p]);
    }
  }

  cancelDraft() {
    this.state.draft = null;
    this.updateTools();
    this.invalidate();
  }

  clearMeasurements() {
    this.state.measurements = [];
    this.state.draft = null;
    this.updateTools();
    this.invalidate();
  }

  // Карандаш — как в Vidi Web: линия по срезу, видна только на своём срезе.
  beginStroke(pane, p) {
    this.state.draft = { type: 'stroke', plane: pane.plane, n: pane.basis().n, pts: [p] };
    this.updateTools();
    this.invalidate();
  }

  addStrokePoint(p) {
    const d = this.state.draft;
    if (!d || d.type !== 'stroke') return;
    d.pts.push(p);
    this.invalidate();
  }

  endStroke() {
    const d = this.state.draft;
    if (!d || d.type !== 'stroke') return;
    if (d.pts.length > 1) this.state.measurements.push(d);
    this.state.draft = null;
    this.updateTools();
    this.invalidate();
  }

  // ------------------------------------------------------------ UI wiring

  bindChrome() {
    // Диалог «только в приложении».
    const dlg = $('#feature-dialog');
    $$('[data-feature]').forEach((b) => b.addEventListener('click', () => this.openFeature(b.dataset.feature)));
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

    // «?» — значки бара и что они делают, как окно «Управление» в Vidi Web.
    // Значок копируется из самого бара: поменяли кнопку — подсказка поменялась с ней.
    const help = $('#help-dialog');
    const list = $('#help-list');
    for (const btn of $$('#toolbar .tool')) {
      const text = TOOL_HELP[btn.dataset.tool];
      if (!text) continue;
      const row = document.createElement('li');
      row.className = 'help-row';
      const icon = document.createElement('span');
      icon.className = 'help-ico' + (btn.classList.contains('tool-danger') ? ' is-danger' : '');
      icon.append($('svg', btn).cloneNode(true));
      const body = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = $('.sr-only', btn).textContent;
      const desc = document.createElement('span');
      desc.className = 'help-text';
      desc.textContent = text;
      body.append(name, desc);
      row.append(icon, body);
      list.append(row);
    }
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
    img.hidden = !f.img;
    if (f.img) img.src = f.img;
    else img.removeAttribute('src');
    img.alt = f.title;
    this.closePops();
    const help = $('#help-dialog');
    if (help.open) help.close();
    dlg.showModal();
  }

  bindViewer() {
    $$('#toolbar .tool').forEach((b) => b.addEventListener('click', () => this.useTool(b.dataset.tool)));
    // Вкладка выбирает проекцию: в «1» — ту, что во весь экран, в «3» — главную, верхнюю.
    $$('[data-pane-tab]').forEach((b) => b.addEventListener('click', () => this.selectPane(b.dataset.paneTab)));

    // Ракурсы 3D — как в Vidi Web.
    $$('#views .view-btn').forEach((b) => b.addEventListener('click', () => {
      this.state.three.lastView = b.dataset.view;
      this.volumePane.setView(b.dataset.view);
    }));

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') this.cancelDraft();
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        this.state.measurements.pop();
        this.updateTools();
        this.invalidate();
      } else if (e.key === 'v' || e.key === 'V') this.setTool('nav');
      else if (e.key === 'm' || e.key === 'M') this.setTool('ruler');
      else if (e.key === 'a' || e.key === 'A') this.setTool('angle');
    });

    this.setTool('nav');
    this.setWindow(this.state.window.center, this.state.window.width);
    this.setThickness(0);
    this.updateTools();
  }
}

const app = new App();
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.vidiDemo = app;
app.start();
