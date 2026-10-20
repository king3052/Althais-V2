// Althais on-page overlay. Runs in every frame of a site the biller allowed (and on Althais's synthetic test screens).
// Every frame: reports page changes, answers "scan" with what parse.js reads, outlines the fields a check is about, and
//              notices a click on the EMR's own Submit button. It never changes the EMR page's own content or blocks a click.
// Top frame:   draws the floating pill and result card in an isolated shadow root.
(() => {
  if (window.__althaisContent) return;
  window.__althaisContent = true;
  const S = globalThis.AlthaisShared;
  const TOP = window === window.top;
  const send = (m) => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (e) {} };   // the extension may have been reloaded
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const MARK = '<svg viewBox="120 85.5 1114 1114" aria-hidden="true"><path d="M353 179Q390 142 428 177L676 402L420 648L197 406Q162 368 199 331ZM924 177Q963 142 1000 178L1157 332Q1194 368 1158 406L930 648L676 402ZM420 648L676 884L429 1107Q390 1142 353 1105L199 952Q162 915 198 878ZM930 648L1151 878Q1187 915 1150 951L992 1106Q955 1142 917 1107L676 884Z"/></svg>';

  let verdict = null;              // latest result for this tab: { verdict, score, flags, fields }
  let outlines = true;
  chrome.storage.local.get(["outlines"], (s) => { outlines = s.outlines !== false; });

  // ---------------- change detection ----------------
  const OURS = new Set(["althais-overlay", "althais-marks"]);
  let ct = 0;
  const changed = () => { clearTimeout(ct); ct = setTimeout(() => send({ t: "changed" }), 600); };
  const mo = new MutationObserver((list) => { if (list.some((m) => !(m.target && OURS.has(m.target.id)) && !(m.addedNodes.length === 1 && OURS.has(m.addedNodes[0].id)))) changed(); });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("input", changed, true);
  document.addEventListener("change", changed, true);
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) changed(); });
  changed();

  // ---------------- outlines (every frame) ----------------
  let marksRoot = null, boxes = [], raf = 0;
  function marksLayer() {
    if (marksRoot) return marksRoot;
    const host = document.createElement("div");
    host.id = "althais-marks";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147482999;";
    (document.body || document.documentElement).appendChild(host);
    marksRoot = host.attachShadow({ mode: "closed" });
    marksRoot.innerHTML = `<style>
      .b{position:fixed;box-sizing:border-box;border:2px solid var(--c);border-radius:5px;background:color-mix(in srgb,var(--c) 7%,transparent);transition:opacity .15s}
      .b span{position:absolute;right:-2px;top:-20px;font:600 11px/18px system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;background:var(--c);padding:0 7px;border-radius:4px 4px 0 4px;white-space:nowrap;letter-spacing:.01em}
      .b.below span{top:auto;bottom:-20px;border-radius:4px 0 4px 4px}
      .b.pulse{animation:p 1.1s ease-out 2}
      @keyframes p{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c) 55%,transparent)}100%{box-shadow:0 0 0 12px transparent}}
      @media (prefers-reduced-motion:reduce){.b.pulse{animation:none;outline:3px solid var(--c)}}
    </style><div id="w"></div>`;
    return marksRoot;
  }
  const COLOR = { error: "#d92d20", warn: "#dc8a09", info: "#1d5bb8" };
  const WORD = { error: "Fix", warn: "Check", info: "Note" };

  function targetsFor(flag) {
    const R = globalThis.__althaisRefs;
    if (!R) return [];
    const kind = S.KIND_OF[flag.code];
    if (!kind) return [];
    const live = (els) => (els || []).filter((el) => el.isConnected);
    let els = live(R.refs[kind]);
    if (flag.codes && flag.codes.length && els.length) {
      const hit = els.filter((el) => { const t = String(el.value || el.innerText || el.textContent || "").toUpperCase(); return flag.codes.some((c) => t.includes(String(c).toUpperCase())); });
      if (hit.length) els = hit;
    }
    const missing = /^no_/.test(flag.code);
    if (!els.length || missing) { const lab = live(R.labels[kind]); if (lab.length) els = missing ? lab : els.concat(lab).slice(0, 1); }
    return els.slice(0, 6);
  }

  function drawMarks() {
    boxes = [];
    if (!verdict || !verdict.verdict || !outlines) { if (marksRoot) marksRoot.getElementById("w").innerHTML = ""; return; }
    const w = marksLayer().getElementById("w");
    w.innerHTML = "";
    const rank = { error: 3, warn: 2, info: 1 };
    const byEl = new Map();
    verdict.flags.forEach((f, i) => {
      const s = S.sev(f.severity);
      targetsFor(f).forEach((el) => {
        const cur = byEl.get(el);
        if (!cur || rank[s] > rank[cur.s]) byEl.set(el, { s, i, kind: S.KIND_OF[f.code], flags: [i].concat(cur ? cur.flags : []) });
        else cur.flags.push(i);
      });
    });
    const labelled = new Set();                 // one tag per kind, so neighbouring cells don't stack labels
    byEl.forEach((v, el) => {
      const d = document.createElement("div");
      d.className = "b";
      d.style.setProperty("--c", COLOR[v.s]);
      const key = v.s + v.kind;
      if (!labelled.has(key)) { labelled.add(key); d.innerHTML = "<span>" + WORD[v.s] + " · " + esc(S.KIND_LABEL[v.kind] || "") + "</span>"; }
      w.appendChild(d);
      boxes.push({ el, d, flags: v.flags });
    });
    place();
  }
  function place() {
    raf = 0;
    const vh = innerHeight, vw = innerWidth;
    boxes.forEach((b) => {
      const r = b.el.getBoundingClientRect();
      const vis = r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      b.d.style.opacity = vis ? "1" : "0";
      if (!vis) return;
      Object.assign(b.d.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
      b.d.classList.toggle("below", r.top < 24);
    });
  }
  const queuePlace = () => { if (!raf && boxes.length) raf = requestAnimationFrame(place); };
  addEventListener("scroll", queuePlace, true);
  addEventListener("resize", queuePlace);
  setInterval(queuePlace, 800);

  function focusFlag(i) {
    const b = boxes.find((x) => x.flags.includes(i));
    if (!b) return;
    b.el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    b.d.classList.remove("pulse"); void b.d.offsetWidth; b.d.classList.add("pulse");
    setTimeout(queuePlace, 350);
  }

  // ---------------- the EMR's own Submit button ----------------
  document.addEventListener("click", (e) => {
    if (!verdict || verdict.verdict !== "fix") return;
    const el = e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"], a');
    if (!el || el.closest("#althais-overlay")) return;
    const label = String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim();
    if (label.length <= 40 && /\b(submit|send|release|bill)\b/i.test(label)) {
      send({ t: "submitWarn", n: verdict.flags.filter((x) => x.severity === "error").length });
    }
  }, true);

  // ---------------- messages ----------------
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.t === "scan") {
      try { const r = globalThis.__althaisParse({ keep: true }); delete r.diag; reply(r); } catch (e) { reply(null); }
      return;
    }
    if (m.t === "verdict") {
      verdict = m.verdict ? m : null;
      drawMarks();
      if (TOP) ui.result(m);
      return;
    }
    if (m.t === "focus") { focusFlag(m.i); return; }
    if (!TOP) return;
    if (m.t === "state") ui.state(m.state, m.text);
    if (m.t === "submitWarn") ui.submitWarn(m.n);
    if (m.t === "toggle") ui.toggle();
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.outlines) { outlines = ch.outlines.newValue !== false; drawMarks(); if (TOP) ui.render(); }
  });

  // ---------------- top frame: pill + card ----------------
  const ui = TOP ? makeUi() : null;

  function makeUi() {
    const host = document.createElement("div");
    host.id = "althais-overlay";
    host.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483000;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial}
      *{box-sizing:border-box}
      .wrap{--brand:#1d5bb8;--fg:#1c2733;--fg2:#4a5868;--mut:#6b7785;--line:#d9dfe6;--bg:#fff;--soft:#f5f7fa;
        --red:#b42318;--red-bg:#fef3f2;--amb:#a15c07;--amb-bg:#fffaeb;--grn:#17784a;--grn-bg:#ecfdf3;
        font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);position:relative}
      @media (prefers-color-scheme:dark){.wrap{--fg:#e6e9ef;--fg2:#b3bbc9;--mut:#8a94a6;--line:#2d333e;--bg:#161a21;--soft:#1d222b;
        --red:#f97066;--red-bg:#2b1715;--amb:#fdb022;--amb-bg:#2a2011;--grn:#47cd89;--grn-bg:#11251b;--brand:#3b7ddd}}
      button{font:inherit;color:inherit;cursor:pointer}
      .pill{display:flex;align-items:center;gap:8px;height:38px;padding:0 14px 0 6px;border-radius:19px;border:1px solid var(--line);background:var(--bg);
        box-shadow:0 6px 20px rgba(16,24,40,.16),0 1px 3px rgba(16,24,40,.1);user-select:none;touch-action:none;transition:box-shadow .15s,transform .15s}
      .pill:hover{box-shadow:0 8px 26px rgba(16,24,40,.22),0 1px 3px rgba(16,24,40,.1)}
      .pill:focus-visible,.x:focus-visible,.btn:focus-visible,.lnk:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
      .m{width:26px;height:26px;border-radius:50%;background:var(--brand);display:grid;place-items:center;flex:none}
      .m svg{width:15px;height:15px;fill:#fff}
      .pill b{font-weight:650;white-space:nowrap}
      .n{min-width:20px;height:20px;padding:0 6px;border-radius:10px;font:700 11.5px/20px system-ui,sans-serif;text-align:center;color:#fff}
      .wrap.idle .pill,.wrap.off .pill{padding:0 6px;width:38px;justify-content:center}
      .wrap.idle .pill b,.wrap.idle .n,.wrap.off .pill b{display:none}
      .wrap.idle .m{background:#8090a3}
      .wrap.clean .m{background:var(--grn)} .wrap.clean b{color:var(--grn)}
      .wrap.review .m{background:var(--amb)} .wrap.review b{color:var(--amb)} .wrap.review .n{background:var(--amb)}
      .wrap.fix .m{background:var(--red)} .wrap.fix b{color:var(--red)} .wrap.fix .n{background:var(--red)}
      .wrap.checking .m svg{animation:spin 1.1s linear infinite}
      .wrap.shake .pill{animation:shake .5s ease 2}
      @keyframes spin{to{transform:rotate(1turn)}}
      @keyframes shake{0%,100%{transform:none}20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(5px)}}
      .card[hidden]{display:none}
      .card{position:absolute;right:0;bottom:48px;width:352px;max-width:calc(100vw - 24px);max-height:min(70vh,560px);display:flex;flex-direction:column;
        background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.08);overflow:hidden;
        transform-origin:bottom right;animation:in .14s ease-out}
      .wrap.down .card{bottom:auto;top:48px;transform-origin:top right}
      .wrap.left .card{right:auto;left:0}
      @keyframes in{from{opacity:0;transform:translateY(6px) scale(.98)}}
      .hd{display:flex;align-items:center;gap:10px;padding:12px 12px 10px 14px;border-bottom:1px solid var(--line)}
      .hd .ic{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--soft);color:var(--mut)}
      .hd .ic svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
      .wrap.clean .hd .ic{background:var(--grn-bg);color:var(--grn)} .wrap.review .hd .ic{background:var(--amb-bg);color:var(--amb)} .wrap.fix .hd .ic{background:var(--red-bg);color:var(--red)}
      .ttl{flex:1;min-width:0}.ttl b{display:block;font-size:14.5px}.ttl span{display:block;font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .score{font:700 15px/1 ui-monospace,Menlo,Consolas,monospace;color:var(--fg2)}.score small{font-size:10px;color:var(--mut)}
      .x{border:0;background:none;width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:var(--mut)}.x:hover{background:var(--soft)}
      .x svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
      .warn{margin:10px 12px 0;padding:9px 11px;border-radius:8px;background:var(--red-bg);color:var(--red);font-weight:600;font-size:12.5px}
      .list{overflow:auto;padding:4px 0}
      .it{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:10px 14px;border-bottom:1px solid var(--line)}
      .it:last-child{border-bottom:0}
      .chip{grid-row:span 3;align-self:start;margin-top:1px;font:700 10px/18px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;padding:0 7px;border-radius:9px}
      .chip.error{background:var(--red-bg);color:var(--red)} .chip.warn{background:var(--amb-bg);color:var(--amb)} .chip.info{background:var(--soft);color:var(--fg2)}
      .msg{color:var(--fg)} .fix{color:var(--fg2);font-size:12px}
      .lnk{justify-self:start;border:0;background:none;padding:0;color:var(--brand);font-weight:600;font-size:12px}
      .lnk:hover{text-decoration:underline}
      .empty{padding:18px 16px;color:var(--fg2)}
      .empty b{display:block;color:var(--fg);margin-bottom:2px}
      .ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--line);background:var(--soft)}
      .btn{border:1px solid var(--line);background:var(--bg);border-radius:7px;padding:5px 10px;font-weight:600;font-size:12.5px}
      .btn:hover{border-color:var(--brand);color:var(--brand)}
      .sw{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2);cursor:pointer}
      .sw input{accent-color:var(--brand);margin:0}
      .sp{flex:1}
      .kbd{font:11px ui-monospace,Menlo,Consolas,monospace;color:var(--mut)}
      .hide{border:0;background:none;color:var(--mut);font-size:12px;padding:0}.hide:hover{color:var(--fg);text-decoration:underline}
      @media (prefers-reduced-motion:reduce){.card,.wrap.checking .m svg,.wrap.shake .pill{animation:none}}
    </style>
    <div class="wrap idle" id="w">
      <div class="card" id="card" role="dialog" aria-label="Althais claim check" hidden></div>
      <button class="pill" id="pill" type="button" aria-expanded="false"><span class="m">${MARK}</span><b id="lbl">Althais</b><span class="n" id="n" hidden></span></button>
    </div>`;
    const $ = (id) => root.getElementById(id);
    const w = $("w"), pill = $("pill"), card = $("card");
    let state = "idle", stateText = "", last = null, open = false, warnN = 0, hidden = false, offHost = false;
    const hostKey = "pos:" + location.host;

    // position (draggable, remembered per site)
    chrome.storage.local.get([hostKey, "offHosts"], (s) => {
      const p = s[hostKey];
      if (p) { host.style.right = p.r + "px"; host.style.bottom = p.b + "px"; }
      offHost = (s.offHosts || []).includes(location.host);
      orient(); render();
    });
    function orient() {
      const r = host.getBoundingClientRect();
      w.classList.toggle("down", r.top < 340);
      w.classList.toggle("left", r.left < 360 && r.right < innerWidth / 2);
    }
    let drag = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, r: parseFloat(host.style.right), b: parseFloat(host.style.bottom), moved: false };
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const pr = pill.getBoundingClientRect();
      host.style.right = Math.min(Math.max(8, drag.r - dx), innerWidth - pr.width - 8) + "px";
      host.style.bottom = Math.min(Math.max(8, drag.b - dy), innerHeight - pr.height - 8) + "px";
      orient();
    });
    pill.addEventListener("pointerup", () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) { chrome.storage.local.set({ [hostKey]: { r: parseFloat(host.style.right), b: parseFloat(host.style.bottom) } }); return; }
      setOpen(!open);
    });
    pill.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } });
    root.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { setOpen(false); pill.focus(); } });
    addEventListener("resize", orient);

    function setOpen(v) { open = v; if (!v) warnN = 0; pill.setAttribute("aria-expanded", String(v)); render(); }

    const ICON = {
      clean: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
      review: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/></svg>',
      fix: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
      idle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
    };
    const TITLE = { clean: "Ready to submit", review: "Worth a look", fix: "Fix before submitting" };
    const CLOSE = '<button class="x" id="close" type="button" aria-label="Minimize"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>';

    function render() {
      if (offHost || hidden) { host.style.display = "none"; return; }
      host.style.display = "";
      const v = last && last.verdict;
      const cls = state === "result" && v ? v : state === "checking" ? (v || "idle") + " checking" : state === "unpaired" || state === "error" ? "review" : "idle";
      w.className = "wrap " + cls + (w.classList.contains("down") ? " down" : "") + (w.classList.contains("left") ? " left" : "") + (warnN ? " shake" : "");
      const issues = last ? last.flags.filter((x) => x.severity === "error" || x.severity === "warn").length : 0;
      $("lbl").textContent = state === "unpaired" ? "Connect Althais" : state === "error" ? "Althais can't check" : v === "clean" ? "Ready to submit" : v === "review" ? "Worth a look" : v === "fix" ? "Fix first" : "Althais";
      $("n").hidden = !(v && v !== "clean" && issues && state !== "unpaired");
      $("n").textContent = issues;
      pill.title = state === "idle" ? "Althais: open a claim and it's checked automatically" : "Althais claim check (Alt+Shift+A)";
      pill.setAttribute("aria-label", "Althais: " + $("lbl").textContent + (issues && v !== "clean" ? ", " + issues + " issues" : ""));
      card.hidden = !open;
      if (!open) return;
      let h = "";
      if (state === "unpaired") {
        h = head("idle", "Connect this browser", "Althais isn't connected yet") +
          '<div class="empty"><b>One step to finish setup</b>Open Althais, go to Revenue › Connect EMR › Browser Extension, and press Connect This Browser.</div>';
      } else if (state === "error" && !v) {
        h = head("review", "Couldn't check this claim", stateText || "Try again in a moment") + '<div class="empty">' + esc(stateText) + "</div>";
      } else if (!v) {
        h = head("idle", "No claim on this screen", location.host) +
          '<div class="empty"><b>Open a claim</b>Althais reads the codes, payer, date and charge on claim screens and checks them automatically.</div>';
      } else {
        const f = last.fields || {};
        const meta = [f.claim_id && "Claim " + f.claim_id, f.payer, f.dos].filter(Boolean).join(" · ") || location.host;
        h = head(v, TITLE[v], meta, last.score);
        if (warnN) h += '<div class="warn" role="alert">This claim still has ' + warnN + " problem" + (warnN === 1 ? "" : "s") + " to fix before it goes out.</div>";
        if (!last.flags.length) h += '<div class="empty"><b>No problems found</b>This is a pre-submission check, not a guarantee of payment.</div>';
        else {
          const order = { error: 0, warn: 1, info: 2 };
          const items = last.flags.map((x, i) => ({ x, i })).sort((a, b) => order[S.sev(a.x.severity)] - order[S.sev(b.x.severity)]);
          h += '<div class="list">' + items.map(({ x, i }) => {
            const s = S.sev(x.severity), fix = S.FIX[x.code], kind = S.KIND_OF[x.code];
            return '<div class="it"><span class="chip ' + s + '">' + { error: "Fix", warn: "Check", info: "Note" }[s] + '</span><div class="msg">' + esc(x.message) + "</div>" +
              (fix ? '<div class="fix">' + esc(fix) + "</div>" : "<div></div>") +
              (kind && outlines ? '<button class="lnk" type="button" data-focus="' + i + '">Show on page</button>' : "<div></div>") + "</div>";
          }).join("") + "</div>";
        }
      }
      h += '<div class="ft"><button class="btn" id="re" type="button">Re-check</button><label class="sw"><input type="checkbox" id="ol"' + (outlines ? " checked" : "") +
        '> Outline fields</label><span class="sp"></span><button class="hide" id="off" type="button">Hide on this site</button></div>';
      card.innerHTML = h;
      root.getElementById("close").onclick = () => { setOpen(false); pill.focus(); };
      root.getElementById("re").onclick = () => { state = "checking"; render(); send({ t: "recheck" }); };
      root.getElementById("ol").onchange = (e) => chrome.storage.local.set({ outlines: e.target.checked });
      root.getElementById("off").onclick = () => {
        chrome.storage.local.get(["offHosts"], (s) => {
          const list = (s.offHosts || []).filter((x) => x !== location.host).concat(location.host);
          chrome.storage.local.set({ offHosts: list });
        });
      };
      card.querySelectorAll("[data-focus]").forEach((b) => (b.onclick = () => send({ t: "focus", i: +b.dataset.focus })));
    }
    function head(kind, title, meta, score) {
      return '<div class="hd"><span class="ic">' + (ICON[kind] || ICON.idle) + '</span><div class="ttl"><b>' + esc(title) + "</b><span>" + esc(meta) + "</span></div>" +
        (score != null ? '<span class="score">' + Math.round(score) + "<small>/100</small></span>" : "") + CLOSE + "</div>";
    }

    chrome.storage.onChanged.addListener((ch) => {
      if (ch.offHosts) { offHost = (ch.offHosts.newValue || []).includes(location.host); send({ t: "recheck" }); render(); }
    });

    const attach = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
    attach();
    setInterval(attach, 2000);              // single-page EMRs sometimes replace <body>
    // pick up a result the worker already has for this tab (e.g. after the page reloads)
    try { chrome.runtime.sendMessage({ t: "current" }, (r) => { void chrome.runtime.lastError; if (r && r.result) { last = Object.assign({ fields: r.out && r.out.fields }, r.result); state = "result"; render(); } }); } catch (e) {}

    return {
      render,
      result(m) {
        if (!m.verdict) { last = null; state = "idle"; warnN = 0; render(); return; }
        const changedClaim = !last || JSON.stringify(last.fields) !== JSON.stringify(m.fields);
        last = m; state = "result";
        if (changedClaim) warnN = 0;
        if (!m.quiet && changedClaim && m.verdict === "fix" && !open) { w.classList.add("shake"); setTimeout(() => w.classList.remove("shake"), 1100); }
        render();
      },
      state(s, text) { state = s; stateText = text || ""; render(); },
      submitWarn(n) { warnN = Math.max(1, n || 1); hidden = false; setOpen(true); setTimeout(() => w.classList.remove("shake"), 1100); },
      toggle() { hidden = !hidden; render(); },
    };
  }
})();
