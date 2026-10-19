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

$("read").onclick = async () => {
  say("readmsg", ""); $("result").innerHTML = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open your EMR claim page in this tab first.");
    const origin = new URL(tab.url).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has && !(await chrome.permissions.request({ origins: [origin] }))) throw new Error("Chrome needs your OK to read this site. Press the button again and choose Allow.");
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["parse.js"] });
    const out = res && res[0] && res[0].result;
    if (!out) throw new Error("Couldn't read this page. Type the codes in below.");
    fill(out.fields);
    const got = Object.keys(out.found).filter((k) => out.found[k]).length;
    let m = got ? "Read " + got + " field" + (got > 1 ? "s" : "") + " from " + out.host + "." : "Nothing recognised on this page. Type the codes in below.";
    if (out.guessed.length) m += " " + out.guessed.join(" and ").toUpperCase() + " were guessed from the page text, so double-check them.";
    say("readmsg", m, !got);
  } catch (e) { say("readmsg", e.message, true); $("form").hidden = false; }
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
    const label = { clean: "Looks clean", review: "Worth a look", fix: "Fix first" }[j.verdict] || j.verdict;
    let h = '<span class="badge ' + j.verdict + '">' + label + "</span> <span class=\"sub\">score " + j.score + "</span>";
    if (!j.flags.length) h += '<p class="note">No problems found. This is a pre-submission check, not a guarantee of payment.</p>';
    j.flags.forEach((x) => { h += '<div class="flag"><span class="ic ' + (x.severity === "error" ? "fix" : "review") + '">' + (x.severity === "error" ? "✕" : "!") + "</span><span></span></div>"; });
    box.innerHTML = h;
    box.querySelectorAll(".flag span:last-child").forEach((el, i) => { el.textContent = j.flags[i].message; });
  } catch (e) { box.innerHTML = ""; const p = document.createElement("p"); p.className = "msg err"; p.textContent = e.message; box.appendChild(p); }
};
init();
