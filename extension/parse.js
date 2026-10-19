// Reads claim fields from the page in front of the person. Injected only when they press "Read this page".
// Returns { fields, found, guessed }. It never looks for a patient name or date of birth.
(function () {
  var MAXTXT = 80;
  var txt = function (el) { return (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim(); };
  var norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); };
  var ICD = /\b[A-TV-Z][0-9][0-9AB](?:\.[0-9A-TV-Z]{1,4})?\b/gi;
  var CPT = /\b(?:\d{5}|[A-V]\d{4})\b/gi;
  var MOD = /\b[A-Z0-9]{2}\b/g;

  var KINDS = [
    ["claim_id", /^(claim|claim id|claim number|claim no|claim #|encounter id|encounter number|visit id|invoice number)$/],
    ["dos", /^(dos|date of service|service date|service dates?|billed service date|visit date|encounter date|from date)$/],
    ["payer", /^(payer|payor|payer name|insurance|insurance name|insurance company|primary insurance|primary payer|primary insurance payer|carrier|plan)$/],
    ["cpt", /^(cpt|cpt code|cpt codes|cpt hcpcs|hcpcs|procedure|procedures|procedure code|procedure codes|proc code|service code|charge code|code)$/],
    ["icd", /^(icd|icd 10|icd10|icd 10 code|icd 10 codes|diagnosis|diagnoses|diagnosis code|diagnosis codes|dx|dx code|dx codes|dx codes icd 10)$/],
    ["modifiers", /^(modifier|modifiers|mod|mods|mod 1|mod 2|modifier 1|modifier 2)$/],
    ["amount", /^(charge|charges|charge amount|amount|total charge|total charges|billed|billed amount|fee|total)$/],
    ["pos", /^(pos|place of service)$/]
  ];
  function kindOf(label) {
    var n = norm(label);
    if (!n || n.length > 40) return null;
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i][1].test(n)) return KINDS[i][0];
    return null;
  }

  var raw = { claim_id: [], dos: [], payer: [], cpt: [], icd: [], modifiers: [], amount: [], pos: [] };
  var add = function (k, v) {
    v = String(v || "").replace(/\s+/g, " ").trim();
    if (v && v.length <= 400 && raw[k].indexOf(v) < 0) raw[k].push(v);
  };

  // 1) form controls: label[for], wrapping label, aria-label, placeholder, name
  var controls = document.querySelectorAll("input, select, textarea");
  controls.forEach(function (el) {
    var t = (el.type || "").toLowerCase();
    if (/^(password|hidden|file|checkbox|radio|submit|button|search)$/.test(t)) return;
    var label = el.getAttribute("aria-label") || "";
    if (!label && el.id) { var l = document.querySelector('label[for="' + el.id.replace(/"/g, "") + '"]'); if (l) label = txt(l); }
    if (!label) { var w = el.closest("label"); if (w) label = txt(w).replace(txt({ innerText: el.value }), ""); }
    var k = kindOf(label) || kindOf(el.getAttribute("placeholder")) || kindOf(el.getAttribute("name")) || kindOf(el.id);
    var v = el.tagName === "SELECT" ? txt(el.options[el.selectedIndex]) : el.value;
    if (k && v) add(k, v);
  });

  // 2) label/value pairs: dt/dd, th/td, two-cell rows, and "Label: value" text nodes
  document.querySelectorAll("dt").forEach(function (dt) { var k = kindOf(txt(dt)); var dd = dt.nextElementSibling; if (k && dd && dd.tagName === "DD") add(k, txt(dd)); });
  document.querySelectorAll("tr").forEach(function (tr) {
    var cells = tr.children;
    if (cells.length === 2) { var k = kindOf(txt(cells[0])); if (k) add(k, txt(cells[1])); }
  });
  document.querySelectorAll("label, span, div, p, strong, b, th, td, dt").forEach(function (el) {
    if (el.children.length > 1) return;
    var t = txt(el);
    if (!t || t.length > MAXTXT) return;
    var m = t.match(/^([^:]{2,40}):\s*(.+)$/);
    if (m) { var k = kindOf(m[1]); if (k) { add(k, m[2]); return; } }
    var k2 = kindOf(t.replace(/:$/, ""));
    if (k2 && !m && !el.closest("thead") && !(el.tagName === "TH" && el.parentElement.children.length > 2)) {
      var nx = el.nextElementSibling;
      if (nx && kindOf(txt(nx).replace(/:$/, ""))) nx = null;
      if (nx && txt(nx) && txt(nx).length <= 200) add(k2, txt(nx));
      else if (!nx && el.parentElement && el.parentElement.children.length === 2 && el.parentElement.children[0] === el && !kindOf(txt(el.parentElement.children[1]))) add(k2, txt(el.parentElement.children[1]));
    }
  });

  var tableAmounts = [];
  // 3) table columns: header names decide which column holds what
  document.querySelectorAll("table").forEach(function (tb) {
    var head = tb.querySelector("thead tr") || tb.querySelector("tr");
    if (!head) return;
    var cols = Array.prototype.map.call(head.children, function (h) { return kindOf(txt(h)); });
    if (!cols.some(Boolean) || cols.filter(Boolean).length < 1) return;
    var rows = tb.querySelectorAll("tbody tr");
    if (!rows.length) rows = Array.prototype.slice.call(tb.querySelectorAll("tr"), 1);
    rows.forEach(function (tr, ri) {
      Array.prototype.forEach.call(tr.children, function (td, i) {
        var k = cols[i];
        if (!k) return;
        if (k === "claim_id" || k === "dos" || k === "payer" || k === "pos") { if (ri === 0) add(k, txt(td)); }
        else if (k === "amount") tableAmounts.push(txt(td));
        else add(k, txt(td));
      });
    });
  });

  // ---- tidy into the shape the server wants
  function splitCodes(list, re, upper) {
    var out = [];
    list.forEach(function (s) { (String(s).toUpperCase().match(re) || []).forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); }); });
    return out;
  }
  var fields = { claim_id: raw.claim_id[0] || "", dos: raw.dos[0] || "", payer: raw.payer[0] || "", pos: raw.pos[0] || "" };
  fields.cpt = splitCodes(raw.cpt, CPT);
  fields.icd = splitCodes(raw.icd, ICD);
  fields.modifiers = [];
  raw.modifiers.forEach(function (s) { String(s).toUpperCase().split(/[\s,;\/]+/).forEach(function (m) { if (/^[A-Z0-9]{2}$/.test(m) && fields.modifiers.indexOf(m) < 0) fields.modifiers.push(m); }); });
  var amt = 0;
  var num = function (s) { return parseFloat(String(s).replace(/[^0-9.\-]/g, "")); };
  if (tableAmounts.length) tableAmounts.forEach(function (s) { var n = num(s); if (!isNaN(n)) amt += n; });
  else for (var ai = 0; ai < raw.amount.length; ai++) { var an = num(raw.amount[ai]); if (!isNaN(an) && an > 0) { amt = an; break; } }
  amt = Math.round(amt * 100) / 100;
  fields.amount = amt || "";
  if (fields.payer.length > 120) fields.payer = fields.payer.slice(0, 120);

  if (!fields.claim_id) {
    var um = (location.search + "&" + location.hash.replace(/^#\/?/, "")).match(/[?&#;](?:claim_?id|claimnumber|claim_?no|claim)=([A-Za-z0-9\-_]{1,40})/i);
    if (um) fields.claim_id = um[1];
  }
  var found = {};
  ["claim_id", "dos", "payer", "cpt", "icd", "modifiers", "amount", "pos"].forEach(function (k) { found[k] = Array.isArray(fields[k]) ? fields[k].length > 0 : !!fields[k]; });

  // 4) last resort: pattern-match the visible text. These are guesses and the panel says so.
  var guessed = [];
  var body = (document.body && document.body.innerText || "").slice(0, 60000);
  if (!fields.icd.length) { var gi = splitCodes([body], ICD); if (gi.length && gi.length <= 12) { fields.icd = gi; guessed.push("icd"); found.icd = true; } }
  if (!fields.cpt.length) {
    var gc = [];
    var re = /(?:cpt|procedure|hcpcs)\D{0,15}?(\d{5}|[A-V]\d{4})\b/gi, mm;
    while ((mm = re.exec(body)) && gc.length < 8) if (gc.indexOf(mm[1].toUpperCase()) < 0) gc.push(mm[1].toUpperCase());
    if (gc.length) { fields.cpt = gc; guessed.push("cpt"); found.cpt = true; }
  }
  var diag = null;
  if (globalThis.__althaisDiag) {
    var shape = function (v) { return String(v || "").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9").slice(0, 14); };
    var labels = [], seenL = {};
    document.querySelectorAll("label, th, dt, span, div, td, strong, b").forEach(function (el) {
      if (labels.length >= 120 || el.children.length > 1) return;
      var t = txt(el);
      if (!t || t.length > 40) return;
      var colon = /:$/.test(t) || el.tagName === "TH" || el.tagName === "LABEL" || el.tagName === "DT";
      if (!colon) return;
      var nx = el.nextElementSibling, key = t;
      if (seenL[key]) return; seenL[key] = 1;
      labels.push({ label: t.replace(/:$/, ""), tag: el.tagName.toLowerCase(), kind: kindOf(t.replace(/:$/, "")), next: nx ? shape(txt(nx)) : "" });
    });
    var inputs = [];
    controls.forEach(function (el) {
      if (inputs.length >= 60 || /^(hidden|password)$/i.test(el.type || "")) return;
      inputs.push({ tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", id: el.id || "", aria: el.getAttribute("aria-label") || "", ph: el.getAttribute("placeholder") || "", val: shape(el.value) });
    });
    var heads = [];
    document.querySelectorAll("table").forEach(function (tb) {
      var h = tb.querySelector("thead tr") || tb.querySelector("tr");
      if (h && heads.length < 20) heads.push(Array.prototype.map.call(h.children, function (c) { return txt(c).slice(0, 30); }));
    });
    var shadow = 0; document.querySelectorAll("*").forEach(function (e) { if (e.shadowRoot) shadow++; });
    var qnames = []; try { new URLSearchParams(location.search).forEach(function (v, k) { qnames.push(k); }); } catch (e) {}
    diag = { top: window === window.top, path: location.origin + location.pathname, query: qnames, labels: labels, inputs: inputs, tableHeaders: heads,
      counts: { tables: document.querySelectorAll("table").length, iframes: document.querySelectorAll("iframe, frame").length, inputs: controls.length, shadowRoots: shadow, textLength: (document.body && document.body.innerText || "").length } };
  }
  return { fields: fields, found: found, guessed: guessed, diag: diag, title: (document.title || "").slice(0, 80), host: location.hostname };
})()
