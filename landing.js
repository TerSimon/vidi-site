// Vidi landing — vanilla interactions (no framework dependency).

(function () {
  // ---- App-window placeholder injector (stand-in for real screenshots) ----
  const PANES = `
    <div class="pane axial"><span class="plabel">Аксиаль</span><span class="anat t">A</span><span class="anat b">P</span><span class="anat l">R</span><span class="anat r">L</span></div>
    <div class="pane sagittal"><span class="plabel">Сагитталь</span><span class="anat t">S</span><span class="anat b">I</span><span class="anat l">A</span><span class="anat r">P</span></div>
    <div class="pane coronal"><span class="plabel">Корональ</span><span class="anat t">S</span><span class="anat b">I</span><span class="anat l">R</span><span class="anat r">L</span></div>
    <div class="pane vol"><span class="plabel">3D · Кость</span></div>`;
  function appwin(tag) {
    return `<div class="appwin">
      <div class="titlebar">
        <div class="lights"><i></i><i></i><i></i></div>
        <div class="wintabs"><span class="wintab on">Пациент_01</span><span class="wintab">Пациент_02</span></div>
      </div>
      <div class="mpr-grid">${PANES}</div>
      <div class="ph-tag">плейсхолдер · ${tag}</div>
    </div>`;
  }
  document.querySelectorAll("[data-appwin]").forEach((el) => {
    el.innerHTML = appwin(el.getAttribute("data-appwin"));
  });

  // ---- Sticky header blur on scroll ----
  const header = document.querySelector(".site-header");
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---- Mobile nav (simple) ----
  const burger = document.querySelector(".nav-burger");
  if (burger) {
    burger.addEventListener("click", () => {
      const links = document.querySelector(".nav-links");
      const open = links.style.display === "flex";
      links.style.cssText = open ? "" :
        "display:flex;position:absolute;top:68px;left:0;right:0;flex-direction:column;background:rgba(11,14,20,.96);backdrop-filter:blur(18px);padding:14px;border-bottom:1px solid var(--hair-soft);gap:2px";
    });
  }

  // ---- FAQ accordion ----
  document.querySelectorAll(".faq-q").forEach((q) => {
    q.addEventListener("click", () => {
      const item = q.closest(".faq-item");
      const ans = item.querySelector(".faq-a");
      const isOpen = item.classList.contains("open");
      if (isOpen) {
        item.classList.remove("open");
        ans.style.maxHeight = "0px";
      } else {
        item.classList.add("open");
        ans.style.maxHeight = ans.querySelector(".faq-a-inner").offsetHeight + "px";
      }
      q.setAttribute("aria-expanded", String(!isOpen));
    });
  });

  // ---- Scroll reveal (re-runnable when hero variant changes) ----
  let io;
  function refreshReveal() {
    const anim = document.documentElement.dataset.anim === "on";
    const els = document.querySelectorAll(".reveal");
    if (!anim) { els.forEach((e) => e.classList.add("in")); return; }
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach((e) => {
      // already-visible (e.g. hidden hero just shown above fold) → reveal now
      const r = e.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92 && r.bottom > 0) { e.classList.add("in"); }
      else { e.classList.remove("in"); io.observe(e); }
    });
  }
  window.__refreshReveal = refreshReveal;
  // initial run (tweaks-app also calls it after applying attrs)
  requestAnimationFrame(refreshReveal);

  // ---- Email form (visual only — no backend) ----
  const form = document.getElementById("lead-form");
  if (form) {
    const email = form.querySelector('input[type="email"]');
    const consent = form.querySelector('input[type="checkbox"]');
    const msg = form.querySelector(".lf-msg");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      msg.className = "lf-msg";
      const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim());
      if (!valid) {
        email.classList.add("err");
        msg.textContent = "Нужен корректный email.";
        msg.classList.add("bad");
        return;
      }
      email.classList.remove("err");
      if (!consent.checked) {
        msg.textContent = "Нужно согласие на обработку персональных данных.";
        msg.classList.add("bad");
        return;
      }
      // Demo: no backend. Owner wires this to a Telegram bot / Formspree (see README).
      msg.textContent = "Готово (демо). Подключите Telegram-бот или сервис форм — см. README.";
      msg.classList.add("ok");
      form.reset();
    });
  }

  // ---- Close mobile nav on link click / smooth anchor offset handled by CSS ----
  document.querySelectorAll('.nav-links a[href^="#"]').forEach((a) => {
    a.addEventListener("click", () => {
      const links = document.querySelector(".nav-links");
      if (window.innerWidth <= 980) links.style.cssText = "";
    });
  });
})();
