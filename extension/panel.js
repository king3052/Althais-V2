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
}

$("gear").onclick = () => { $("settings").hidden = !$("settings").hidden; };
$("save").onclick = async () => {
  cfg = { server: $("server").value.trim() || DEFAULT_SERVER, token: $("token").value.trim() };
  await store.set(cfg); say("setmsg", "Saved.");
};
$("test").onclick = async () => {
  cfg = { server: $("server").value.trim() || DEFAULT_SERVER, token: $("token").value.trim() };
  try { await api("/api/extension/ping"); await store.set(cfg); say("setmsg", "Connected. Token works."); }
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

function showResult(j) {
  const box = $("result");
    const label = { clean: "Looks clean", review: "Worth a look", fix: "Fix first" }[j.verdict] || j.verdict;
    let h = '<span class="badge ' + j.verdict + '">' + label + "</span> <span class=\"sub\">score " + j.score + "</span>";
    if (!j.flags.length) h += '<p class="note">No problems found. This is a pre-submission check, not a guarantee of payment.</p>';
    j.flags.forEach((x) => { h += '<div class="flag"><span class="ic ' + (x.severity === "error" ? "fix" : "review") + '">' + (x.severity === "error" ? "✕" : "!") + "</span><span></span></div>"; });
    box.innerHTML = h;
    box.querySelectorAll(".flag span:last-child").forEach((el, i) => { el.textContent = j.flags[i].message; });
}

$("fetch").onclick = async () => {
  const f = $("form"), box = $("result");
  if (!cfg.token) { $("settings").hidden = false; say("setmsg", "Paste your pairing token first.", true); return; }
  box.textContent = "Fetching...";
  try {
    const j = await api("/api/extension/lookup", { method: "POST", body: JSON.stringify({ claim_id: f.claim_id.value }) });
    fill(j.fields); showResult(j); say("readmsg", "Codes came from your athenahealth connection, not the screen.");
  } catch (e) { box.innerHTML = ""; const p = document.createElement("p"); p.className = "msg err"; p.textContent = e.message; box.appendChild(p); }
};

const list = (s) => s.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean);
$("form").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = $("form"), box = $("result");
  if (!cfg.token) { $("settings").hidden = false; say("setmsg", "Paste your pairing token first.", true); return; }
  box.textContent = "Checking...";
  try {
    const j = await api("/api/extension/check", { method: "POST", body: JSON.stringify({ claim: {
      claim_id: f.claim_id.value, dos: f.dos.value, payer: f.payer.value, cpt: list(f.cpt.value), icd: list(f.icd.value),
      modifiers: list(f.modifiers.value), amount: f.amount.value } }) });
    showResult(j);
  } catch (e) { box.innerHTML = ""; const p = document.createElement("p"); p.className = "msg err"; p.textContent = e.message; box.appendChild(p); }
};
init();
