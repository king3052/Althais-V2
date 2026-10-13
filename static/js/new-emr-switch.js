/* "Switch To New EMR" on every page of the previous EMR, for anyone who went back (Settings > Previous EMR, or
   /ui/classic). /ui/new clears that choice and opens the new EMR. Not shown on sign-in pages, the public site,
   the admin console, or the new EMR itself. */
(function () {
  "use strict";
  var p = location.pathname;
  if (/^\/(v4|admin|login|logout|signup|register|forgot|reset|set-password|invite|onboarding|demo|pilot|landing|starter)(\/|$)/.test(p) || p === "/") return;
  function add() {
    var u = window.__ALTHAIS_USER__;
    if (u && Array.isArray(u.products) && u.products.length && u.products.indexOf("suite") < 0) return;   // single-tool plans have no new EMR
    if (document.getElementById("new-emr-switch")) return;
    var a = document.createElement("a");
    a.id = "new-emr-switch"; a.href = "/ui/new"; a.title = "Open the new Althais EMR";
    a.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4"/></svg>Switch To New EMR';
    a.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:9999;display:inline-flex;align-items:center;gap:8px;padding:9px 14px;" +
      "background:var(--brand, #0d5bd7);color:var(--brand-on, #fff);border-radius:6px;font:600 13px/1 Inter, system-ui, sans-serif;" +
      "text-decoration:none;box-shadow:0 6px 18px rgba(15,17,22,.22);";
    a.onmouseenter = function () { a.style.filter = "brightness(1.08)"; };
    a.onmouseleave = function () { a.style.filter = ""; };
    document.body.appendChild(a);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();
