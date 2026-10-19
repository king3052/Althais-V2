const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "https://web-production-8fe4.up.railway.app";
let cfg = { server: DEFAULT_SERVER, token: "" };

const store = {
  get: () => new Promise((r) => chrome.storage.local.get(["server", "token"], r)),
  set: (o) => new Promise((r) => chrome.storage.local.set(o, r)),
};
const say = (id, text, err) => { const el = $(id); el.textContent = text || ""; el.className = "msg" + (err ? " err" : ""); };
const base = () => (cfg.server || DEFAULT_SERVER).replace(/\/+$/, "");

async function api(path, opts) {
  let r;
  try {
    r = await fetch(base() + path, Object.assign({ headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" } }, opts));
  } catch (e) { throw new Error("Couldn't reach Althais. Check the address in settings and your connection."); }
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || "Althais returned an error (" + r.status + ").");
  return j;
}

async function init() {
  const s = await store.get();
  cfg = { server: s.server || DEFAULT_SERVER, token: s.token || "" };
  $("server").value = cfg.server; $("token").value = cfg.token;
  if (!cfg.token) $("settings").hidden = false;
  status();
}

$("gear").onclick = () => { $("settings").hidden = !$("settings").hidden; };
$("save").onclick = async () => {
  cfg = { server: $("server").value.trim() || DEFAULT_SERVER, token: $("token").value.trim() };
  await store.set(cfg); say("setmsg", "Saved."); status();
};
$("test").onclick = async () => {
  cfg = { server: $("server").value.trim() || DEFAULT_SERVER, token: $("token").value.trim() };
  try { await api("/api/extension/ping"); await store.set(cfg); say("setmsg", "Connected. Token works."); status(); $("settings").hidden = true; }
  catch (e) { say("setmsg", e.message, true); }
};

function fill(fields) {
  const f = $("form");
  f.hidden = false;
  f.claim_id.value = fields.claim_id || ""; f.dos.value = fields.dos || ""; f.payer.value = fields.payer || "";
  f.cpt.value = (fields.cpt || []).join(", "); f.icd.value = (fields.icd || []).join(", "); f.modifiers.value = (fields.modifiers || []).join(", ");
  f.amount.value = fields.amount || "";
}

// Reads every frame of the tab (athenaOne and other EMRs put claim screens inside frames), then merges what each frame found.
async function scan(diag) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open your EMR claim page in this tab first.");
  let frames = [];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }) || []; } catch (e) {}
  const origins = [...new Set([tab.url, ...frames.map((f) => f.url)].filter((u) => /^(https:|http:\/\/localhost)/.test(u || "")).map((u) => new URL(u).origin + "/*"))];
  if (!origins.length) throw new Error("This page isn't on a secure (https) address, so it can't be read.");
  const has = await chrome.permissions.contains({ origins });
  if (!has && !(await chrome.permissions.request({ origins }))) throw new Error("Chrome needs your OK to read this site. Press the button again and choose Allow.");
  const target = { tabId: tab.id, allFrames: true };
  await chrome.scripting.executeScript({ target, func: (d) => { globalThis.__althaisDiag = d; }, args: [!!diag] });
  const res = await chrome.scripting.executeScript({ target, files: ["parse.js"] });
  return (res || []).map((r) => r.result).filter(Boolean);
}

function merge(outs) {
  const f = { claim_id: "", dos: "", payer: "", pos: "", cpt: [], icd: [], modifiers: [], amount: "" };
  const found = {}, guessed = new Set(), hosts = new Set();
  // Frames with labelled fields beat frames that only guessed from page text.
  outs.sort((a, b) => a.guessed.length - b.guessed.length);
  outs.forEach((o) => {
    hosts.add(o.host);
    for (const k of ["claim_id", "dos", "payer", "pos", "amount"]) if (!f[k] && o.fields[k]) f[k] = o.fields[k];
    for (const k of ["cpt", "icd", "modifiers"]) if (!f[k].length || !o.guessed.includes(k)) o.fields[k].forEach((x) => { if (!f[k].includes(x)) f[k].push(x); });
    o.guessed.forEach((k) => guessed.add(k));
    Object.keys(o.found).forEach((k) => { if (o.found[k]) found[k] = true; });
  });
  return { fields: f, found, guessed: [...guessed], host: [...hosts].filter(Boolean).join(", "), frames: outs.length };
}

$("read").onclick = async () => {
  say("readmsg", ""); $("result").innerHTML = "";
  try {
    const outs = await scan(false);
    if (!outs.length) throw new Error("Couldn't read this page. Type the codes in below.");
    const out = merge(outs);
    fill(out.fields);
    const got = Object.keys(out.found).filter((k) => out.found[k]).length;
    let m = got ? "Read " + got + " field" + (got > 1 ? "s" : "") + " from " + out.host + (out.frames > 1 ? " (" + out.frames + " frames)" : "") + "." : "Nothing recognised on this page. Type the codes in below, or create a page report below.";
    if (out.guessed.length) m += " " + out.guessed.join(" and ").toUpperCase() + " were guessed from the page text, so double-check them.";
    say("readmsg", m, !got);
  } catch (e) { say("readmsg", e.message, true); $("form").hidden = false; }
};

$("mkdiag").onclick = async () => {
  try {
    const outs = await scan(true);
    const rep = { tool: "althais-extension 0.2", when: new Date().toISOString(), frames: outs.map((o) => ({ matched: o.found, guessed: o.guessed, layout: o.diag })) };
    $("diagout").value = JSON.stringify(rep, null, 1); $("diagout").hidden = false; $("copydiag").hidden = false;
  } catch (e) { say("readmsg", e.message, true); }
};
$("copydiag").onclick = async () => { $("diagout").select(); try { await navigator.clipboard.writeText($("diagout").value); } catch (e) { document.execCommand("copy"); } $("copydiag").textContent = "Copied"; };

const ICONS = {
  clean: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>',
  review: '<svg viewBox="0 0 24 24"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  fix: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
};
const LABEL = { clean: "Looks clean", review: "Worth a look", fix: "Fix first" };
const SEV = { error: "Fix", warn: "Check", info: "Note" };
function showResult(j) {
  const box = $("result"), v = LABEL[j.verdict] ? j.verdict : "review";
  let h = '<section class="verdict ' + v + '"><div class="vhead">' + ICONS[v] + "<b>" + LABEL[v] + '</b><span class="score">' + Number(j.score) + "/100</span></div>" +
    '<div class="meter"><i style="width:' + Math.max(0, Math.min(100, Number(j.score))) + '%"></i></div>';
  if (!j.flags.length) h += '<p class="vnote">No problems found. This is a pre-submission check, not a guarantee of payment.</p>';
  else h += '<div class="flags">' + j.flags.map((x) => '<div class="flag"><span class="chip ' + (SEV[x.severity] ? x.severity : "info") + '">' + (SEV[x.severity] || "Note") + "</span><span class=\"fm\"></span></div>").join("") + "</div>";
  box.innerHTML = h + "</section>";
  box.querySelectorAll(".fm").forEach((el, i) => { el.textContent = j.flags[i].message; });
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function busy(text) { $("result").innerHTML = '<div class="busy"><span class="spin"></span><span></span></div>'; $("result").querySelector(".busy span:last-child").textContent = text; }
function fail(e) { const box = $("result"); box.innerHTML = ""; const p = document.createElement("p"); p.className = "msg err"; p.textContent = e.message; box.appendChild(p); }
async function status() {
  const dot = $("dot"), t = $("conn");
  if (!cfg.token) { dot.className = "dot"; t.textContent = "Not connected. Open settings to pair."; return; }
  try { await api("/api/extension/ping"); dot.className = "dot ok"; t.textContent = "Connected to " + new URL(base()).hostname; }
  catch (e) { dot.className = "dot bad"; t.textContent = e.message; }
}

$("fetch").onclick = async () => {
  const f = $("form"), box = $("result");
  if (!cfg.token) { $("settings").hidden = false; say("setmsg", "Paste your pairing token first.", true); return; }
  busy("Fetching from athenahealth…");
  try {
    const j = await api("/api/extension/lookup", { method: "POST", body: JSON.stringify({ claim_id: f.claim_id.value }) });
    fill(j.fields); showResult(j); say("readmsg", "Codes came from your athenahealth connection, not the screen.");
  } catch (e) { fail(e); }
};

const list = (s) => s.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
$("form").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = $("form"), box = $("result");
  if (!cfg.token) { $("settings").hidden = false; say("setmsg", "Paste your pairing token first.", true); return; }
  busy("Checking claim…");
  try {
    const j = await api("/api/extension/check", { method: "POST", body: JSON.stringify({ claim: {
      claim_id: f.claim_id.value, dos: f.dos.value, payer: f.payer.value, cpt: list(f.cpt.value), icd: list(f.icd.value),
      modifiers: list(f.modifiers.value), amount: f.amount.value } }) });
    showResult(j);
  } catch (e) { fail(e); }
};
init();
