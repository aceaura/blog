/* 界·外 —— 共享脚本：进度线 / 深浅切换 / 章节眉线 / 复制钮 / 字体降级 */
(function () {
  "use strict";

  /* ---- 主题：默认浅色，记忆选择；暗色 token 已独立校准 ---- */
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("jw-theme");
    if (saved) root.setAttribute("data-theme", saved);
  } catch (e) {}
  function syncBtn() {
    var b = document.querySelector(".themebtn");
    if (!b) return;
    var dark = root.getAttribute("data-theme") === "dark";
    b.textContent = dark ? "☀" : "☾";
    b.setAttribute("aria-label", dark ? "切换到浅色" : "切换到暗色");
  }
  window.jwToggleTheme = function () {
    var dark = root.getAttribute("data-theme") === "dark";
    var next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("jw-theme", next); } catch (e) {}
    syncBtn();
  };
  syncBtn();

  /* ---- 阅读进度线（transform，不占布局） ---- */
  var bar = document.querySelector(".progress");
  var pct = document.querySelector(".topbar .pct");
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? Math.min(1, h.scrollTop / max) : 0;
    if (bar) bar.style.transform = "scaleX(" + p + ")";
    if (pct) pct.textContent = Math.round(p * 100) + "%";
  }
  if (bar || pct) {
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    onScroll();
  }

  /* ---- 章节短眉线进入视口生长（一次性） ---- */
  var h2s = document.querySelectorAll(".prose h2");
  if ("IntersectionObserver" in window && h2s.length) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("inview"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -12% 0px" });
    h2s.forEach(function (h) { io.observe(h); });
  } else {
    h2s.forEach(function (h) { h.classList.add("inview"); });
  }

  /* ---- 参数卡复制钮 ---- */
  document.querySelectorAll(".paramcard .copybtn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var pre = btn.closest(".paramcard").querySelector("pre");
      if (!pre) return;
      var txt = pre.innerText;
      function done() { var o = btn.textContent; btn.textContent = "已录"; setTimeout(function () { btn.textContent = o; }, 1400); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  });

  /* ---- webfont 降级：CDN 全挂时微调，仍是一 body 面的宋体读物 ---- */
  if (document.fonts && document.fonts.check) {
    var ok = false;
    try { ok = document.fonts.check('16px "Noto Serif SC"'); } catch (e) {}
    if (!ok) {
      var to = setTimeout(function () { root.classList.add("no-webfont"); }, 2600);
      if (document.fonts.ready) {
        document.fonts.ready.then(function () {
          try {
            if (document.fonts.check('16px "Noto Serif SC"')) { clearTimeout(to); root.classList.remove("no-webfont"); }
            else root.classList.add("no-webfont");
          } catch (e) {}
        });
      }
    }
  }
})();
