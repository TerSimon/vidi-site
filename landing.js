// Vidi landing — vanilla interactions, без зависимостей.
// FAQ — нативный <details>, отзывы — сетка: для них JS не нужен.

(function () {
  window.__vidiReady = true;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasIO = "IntersectionObserver" in window;

  // ---- Mobile nav ----
  const burger = document.querySelector(".nav-burger");
  const nav = document.getElementById("site-nav");
  if (burger && nav) {
    const setOpen = (open) => {
      nav.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
    };
    burger.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("open")) { setOpen(false); burger.focus(); }
    });
  }

  // ---- Hero: сцена «архив → исследование» ----
  // Тайминги живут в CSS; здесь — старт, когда окно в кадре, финал и повтор.
  const stage = document.getElementById("stage");
  if (stage) {
    const SCENE_MS = 4300;
    const planeButtons = Array.from(stage.querySelectorAll(".planes button"));
    let pinned = "";
    let cycleTimer = 0;

    const showPane = (name) => { stage.dataset.pane = name || pinned; };

    const cyclePanes = () => {
      const order = ["axial", "sagittal", "coronal", "vol"];
      let i = 0;
      clearInterval(cycleTimer);
      cycleTimer = setInterval(() => {
        if (i < order.length) { showPane(order[i++]); }
        else { clearInterval(cycleTimer); showPane(""); }
      }, 520);
    };

    const finish = () => {
      stage.classList.add("is-done");
      cyclePanes();
    };

    const play = () => {
      stage.classList.add("is-playing");
      setTimeout(finish, SCENE_MS);
    };

    if (reduceMotion) {
      stage.dataset.pane = "";
    } else if (hasIO) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) { io.disconnect(); play(); }
      }, { threshold: 0.25 });
      io.observe(stage.querySelector(".window"));
    } else {
      finish();
    }

    const replay = stage.querySelector("[data-replay]");
    if (replay) {
      replay.addEventListener("click", () => {
        clearInterval(cycleTimer);
        showPane("");
        stage.classList.remove("is-done");
        // пересоздаём узлы — CSS-анимации стартуют заново
        stage.querySelectorAll(".drop").forEach((el) => el.replaceWith(el.cloneNode(true)));
        setTimeout(finish, SCENE_MS);
      });
    }

    planeButtons.forEach((btn) => {
      const name = btn.dataset.pane;
      btn.addEventListener("pointerenter", () => { clearInterval(cycleTimer); showPane(name); });
      btn.addEventListener("pointerleave", () => showPane(""));
      btn.addEventListener("focus", () => { clearInterval(cycleTimer); showPane(name); });
      btn.addEventListener("blur", () => showPane(""));
      btn.addEventListener("click", () => {
        pinned = pinned === name ? "" : name;
        planeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pane === pinned)));
        showPane(pinned);
      });
    });
  }

  // ---- Дерево архива: проигрывается один раз, когда попало в кадр ----
  const tree = document.getElementById("tree");
  if (tree) {
    if (reduceMotion || !hasIO) {
      tree.classList.add("is-on");
    } else {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting)) { io.disconnect(); tree.classList.add("is-on"); }
      }, { threshold: 0.45 });
      io.observe(tree);
    }
  }

  // ---- Возможности: шаг в центре экрана выбирает кадр справа ----
  const frame = document.getElementById("story-frame");
  const steps = Array.from(document.querySelectorAll(".story-step"));
  if (frame && steps.length && hasIO) {
    const shots = Array.from(frame.querySelectorAll("img"));
    let current = 0;
    const setActive = (idx) => {
      if (idx === current) return;
      current = idx;
      steps.forEach((s, i) => s.classList.toggle("on", i === idx));
      shots.forEach((img, i) => img.classList.toggle("on", i === idx));
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) setActive(Number(en.target.dataset.shot)); });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((s) => io.observe(s));
  }

  // ---- Интерактив: расстояние от импланта до канала ----
  const demo = document.getElementById("canal-demo");
  const range = document.getElementById("depth");
  if (demo && range) {
    const CANAL_TOP = 279;   // верхний край канала на схеме, px
    const PX_PER_MM = 17;
    const IMPLANT_TOP = 40;
    const D_MAX = 4;
    const D_MIN = 0.2;
    const LABELS = { good: "Безопасно", warn: "Близко", danger: "Опасно" };

    const body = demo.querySelector("#implant-body");
    const thread = demo.querySelector("#implant-thread");
    const mLine = demo.querySelector("#m-line");
    const mTop = demo.querySelector("#m-top");
    const mText = demo.querySelector("#m-text");
    const val = document.getElementById("demo-val");
    const stateEl = document.getElementById("demo-state");

    const update = () => {
      const v = Number(range.value);
      const d = D_MAX - (v / 100) * (D_MAX - D_MIN);
      const apex = CANAL_TOP - d * PX_PER_MM;
      const text = d.toFixed(1);
      const shown = Number(text); // порог — по тому же числу, что видит врач
      const state = shown >= 2 ? "good" : shown >= 1 ? "warn" : "danger";

      body.setAttribute("height", (apex - IMPLANT_TOP).toFixed(1));
      thread.setAttribute("height", Math.max(0, apex - IMPLANT_TOP - 24).toFixed(1));
      mLine.setAttribute("y1", apex.toFixed(1));
      mTop.setAttribute("y1", apex.toFixed(1));
      mTop.setAttribute("y2", apex.toFixed(1));
      mText.setAttribute("y", ((apex + CANAL_TOP) / 2 + 5).toFixed(1));
      mText.textContent = text + " мм";

      demo.dataset.state = state;
      val.firstChild.nodeValue = text;
      stateEl.textContent = LABELS[state];
      stateEl.className = "badge badge-" + state;
      range.style.setProperty("--fill", v + "%");
      range.setAttribute("aria-valuetext", "До канала " + text + " мм — " + LABELS[state].toLowerCase());
    };
    range.addEventListener("input", update);
    update();
  }

  // ---- Vidi Web: скриншоты с телефона сменяются сами, чип плоскости выбирает кадр ----
  // Смена идёт, только пока телефон в кадре; под курсором и при «Уменьшить движение» — стоит.
  const webShots = document.getElementById("web-shots");
  if (webShots) {
    const SHOT_MS = 3200;
    const imgs = Array.from(webShots.querySelectorAll(".phone-shots img"));
    const chips = Array.from(webShots.querySelectorAll(".web-planes button"));
    let idx = 0;
    let timer = 0;
    let inView = !hasIO;
    let hovered = false;

    const show = (i) => {
      idx = i;
      imgs.forEach((img, k) => img.classList.toggle("on", k === i));
      chips.forEach((chip, k) => chip.setAttribute("aria-pressed", String(k === i)));
    };
    const stop = () => { clearInterval(timer); timer = 0; };
    const start = () => {
      stop();
      if (reduceMotion || !inView || hovered) return;
      timer = setInterval(() => show((idx + 1) % imgs.length), SHOT_MS);
    };

    chips.forEach((chip, k) => chip.addEventListener("click", () => { show(k); start(); }));
    const phone = webShots.querySelector(".phone");
    phone.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { hovered = true; stop(); } });
    phone.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { hovered = false; start(); } });

    if (hasIO) {
      new IntersectionObserver((entries) => {
        inView = entries.some((en) => en.isIntersecting);
        start();
      }, { threshold: 0.3 }).observe(phone);
    } else {
      start();
    }
  }

  // ---- Карточки тарифа: подсветка следует за курсором (как plan-card в дизайн-системе) ----
  if (window.matchMedia("(pointer: fine)").matches) {
    document.querySelectorAll(".plan").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", (e.clientX - r.left) + "px");
        card.style.setProperty("--my", (e.clientY - r.top) + "px");
      });
    });
  }

  // ---- Analytics: data-evt → цель Яндекс.Метрики (заработает после установки счётчика) ----
  const YM_COUNTER_ID = 0; // TODO: номер счётчика Метрики
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-evt]");
    if (el && YM_COUNTER_ID && typeof window.ym === "function") {
      window.ym(YM_COUNTER_ID, "reachGoal", el.dataset.evt);
    }
  });
})();
