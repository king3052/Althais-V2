/* Turns a visit note and its reviewed codes into a claim, checks it, and sends it through the server's claim gate
   (/api/billing/claims/transmit, the same one Virtual SOAP uses). Shared by the encounter workspace (sign as you go)
   and the Sign-Off page (sign everything at the end of the day), so both build exactly the same claim.
   Needs window.__ALTHAIS_NS__ (the clinic's storage prefix) and window.__ALTHAIS_USER__. */
(function () {
  var NS = function () { return (window.__ALTHAIS_NS__ || '') + '::'; };
  var K = function (k) { return NS() + 'althais.' + k + '.v1'; };
  function read(k, d) { try { var v = JSON.parse(localStorage.getItem(K(k))); return v == null ? d : v; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(K(k), JSON.stringify(v)); } catch (e) {} }

  // Same seed rates as the EMR's fee schedule (Settings > Billing & Claims); a clinic's saved schedule replaces them.
  var DEFAULT_FEES = { '99213': 109.32, '99214': 167.09, '99215': 224.86, '99203': 136.58, '99204': 211.61, '99205': 273.53, '99285': 384.32, '81001': 5.29, '73721': 296.14 };
  function fees() {
    var rows = read('fee_schedule', null);
    if (!Array.isArray(rows) || !rows.length) return DEFAULT_FEES;
    var m = {}; rows.forEach(function (r) { if (r && r.code) m[String(r.code).trim().toUpperCase()] = Number(r.rate) || 0; }); return m;
  }
  var POS_NAMES = { '11': '11 · Office', '02': '02 · Telehealth', '22': '22 · Outpatient hospital', '21': '21 · Inpatient hospital' };

  // The note as text, in the layout Virtual SOAP sends for coding and puts on the claim.
  function noteText(s) {
    s = s || {}; var v = s.vitals || {};
    var na = function (x) { return x && String(x).trim() ? x : 'Not documented'; };
    return 'CHIEF COMPLAINT: ' + na(s.cc) + '\n\nHPI: ' + na(s.hpi) + '\n\nROS: ' + na(s.ros) +
      '\n\nPAST MEDICAL HISTORY: ' + na(s.pmh) + '\n\nPAST SURGICAL HISTORY: ' + na(s.psh) + '\n\nFAMILY HISTORY: ' + na(s.fh) +
      '\n\nSOCIAL HISTORY: ' + na(s.sh) + '\n\nHOSPITALIZATIONS: ' + na(s.hospitalizations) + '\n\nMEDICATIONS: ' + na(s.medications) +
      '\n\nALLERGIES: ' + na(s.allergies) + '\n\nVITALS: BP ' + (v.bp || '-') + ', HR ' + (v.hr || '-') + ', Temp ' + (v.temp || '-') +
      ', RR ' + (v.rr || '-') + ', SpO2 ' + (v.spo2 || '-') + ', Wt ' + (v.weight || '-') +
      '\n\nEXAM: ' + na(s.exam) + '\n\nLABS / IMAGING: ' + na(s.labs) + '\n\nASSESSMENT: ' + na(s.assessment) + '\n\nPLAN: ' + na(s.plan);
  }

  function hasInsurance(P) { return !!(P && P.insPrimary && P.insPrimary !== '-'); }
  function insuredId(P) { var m = P && P.insPrimaryMeta; return m && !/^[—-]$/.test(m) && !/^eligible$/i.test(m) ? m.replace(/^Mbr\s*/i, '') : ''; }
  function me() { var u = window.__ALTHAIS_USER__ || {}; return u.provider_name || u.full_name || ''; }

  // opts: { patient, note, structured, codes, ignored }
  function build(opts) {
    var P = opts.patient, note = opts.note || {}, S = opts.structured || note.structured || {}, codes = opts.codes || [], F = fees();
    var accepted = codes.filter(function (c) { return c.state === 'acc'; });
    var cpts = accepted.filter(function (c) { return c.type === 'CPT'; }), icds = accepted.filter(function (c) { return c.type !== 'CPT'; });
    var pointers = icds.slice(0, 4).map(function (_, k) { return String.fromCharCode(65 + k); }).join('');
    var lines = cpts.map(function (c) { var rate = F[String(c.code).toUpperCase()] || 0, units = Math.max(1, parseInt(c.units, 10) || 1); return { c: c, rate: rate, units: units, charge: rate * units, pointers: pointers }; });
    return {
      P: P, note: note, S: S, codes: codes, ignored: opts.ignored || {}, accepted: accepted, cpts: cpts, icds: icds, lines: lines,
      amount: lines.reduce(function (s, l) { return s + l.charge; }, 0),
      conf: Math.max.apply(null, accepted.map(function (c) { return Number(c.conf) || 85; }).concat([85])),
      insuredId: insuredId(P), provider: note.provider || me() || (P && P.pcp) || '', svcDate: note.date || '',
    };
  }

  // [level, text]: 'stop' can't be sent, 'warn' is worth a look, 'info' is just so you know
  function warnings(cl) {
    var w = [], P = cl.P, codes = cl.codes, ig = cl.ignored;
    var list = function (a) { return a.map(function (c) { return c.code; }).join(', '); };
    if (!P) { w.push(['stop', 'The patient for this visit is no longer in the patient list.']); return w; }
    if (!cl.lines.length) w.push(['stop', 'No CPT code accepted. A claim needs at least one service.']);
    if (!hasInsurance(P)) w.push(['stop', 'No insurance on file. Add it to the patient before sending.']);
    else if (!cl.insuredId) w.push(['warn', 'No member ID on file for ' + P.insPrimary + '. The payer may reject the claim without it.']);
    if (!cl.icds.length) w.push(['warn', 'No diagnosis code accepted. Every service line needs a diagnosis to point to.']);
    var unpriced = cl.lines.filter(function (l) { return !l.rate; });
    if (unpriced.length) w.push(['warn', 'No fee on file for ' + unpriced.map(function (l) { return l.c.code; }).join(', ') + '. Its charge shows as $0.00 (Settings › Billing & Claims › Fee schedule).']);
    var gaps = codes.filter(function (c) { return c.state === 'acc' && c.gap && !ig[c.code]; });
    if (gaps.length) w.push(['warn', gaps.length + ' documentation issue' + (gaps.length === 1 ? '' : 's') + ' still open (' + list(gaps) + '), which raises the chance of a denial.']);
    var stale = codes.filter(function (c) { return c.state === 'acc' && c.stale; });
    if (stale.length) w.push(['warn', list(stale) + ' ' + (stale.length === 1 ? 'is' : 'are') + ' no longer suggested by the note. Check ' + (stale.length === 1 ? 'it still applies' : 'they still apply') + '.']);
    var low = codes.filter(function (c) { return c.state === 'acc' && !c.timeVerified && c.conf && c.conf < 75; });
    if (low.length) w.push(['warn', 'Low confidence on ' + low.map(function (c) { return c.code + ' (' + c.conf + '%)'; }).join(', ') + '.']);
    var pending = codes.filter(function (c) { return !c.state; });
    if (pending.length) w.push(['info', pending.length + ' suggested code' + (pending.length === 1 ? ' was' : 's were') + ' neither accepted nor rejected and won’t be on the claim: ' + list(pending) + '.']);
    return w;
  }

  function snap(cl, claimId) {
    var P = cl.P;
    return {
      patient: P.name, mrn: P.mrn, dob: P.dob || '', sex: P.sex || '', provider: cl.provider, payer: P.insPrimary, svcDate: cl.svcDate, pos: cl.S.pos || '11',
      addrStreet: P.addrStreet || '', addrCity: P.addrCity || '', addrState: P.addrState || '', addrZip: P.addrZip || '', addrPhone: P.addrPhone || '',
      insuredId: cl.insuredId,
      cpts: cl.lines.map(function (l) { return { code: l.c.code, description: l.c.desc, type: 'CPT', confidence: l.c.conf, modifier: l.c.modifier || '', units: l.units }; }),
      icds: cl.icds.map(function (c) { return { code: c.code, description: c.desc, type: 'ICD-10', confidence: c.conf }; }),
      totalAmt: cl.amount, conf: cl.conf, note: noteText(cl.S), claimId: claimId,
    };
  }
  function newClaimId() { return 'CL-' + Date.now().toString().slice(-7) + String(Math.floor(Math.random() * 10)); }

  function saveRecord(cl, s, status, extra) {
    var rec = { patient: cl.P.name, mrn: cl.P.mrn, claimId: s.claimId, provider: cl.provider, payer: cl.P.insPrimary, cpt: s.cpts[0] ? s.cpts[0].code : '', icd: s.icds[0] ? s.icds[0].code : '',
      amount: cl.amount, conf: cl.conf, status: status, ts: new Date().toISOString(), noteId: cl.note.id, snap: JSON.parse(JSON.stringify(s)) };
    Object.keys(extra || {}).forEach(function (k) { rec[k] = extra[k]; });
    var claims = read('claims', []); claims.unshift(rec); write('claims', claims);
    return rec;
  }
  function setNote(noteId, fields) {
    var notes = read('notes', []), n = notes.find(function (x) { return x.id === noteId; });
    if (!n) return null;
    Object.keys(fields).forEach(function (k) { if (fields[k] === undefined) delete n[k]; else n[k] = fields[k]; });
    write('notes', notes); return n;
  }

  // Sign as you go, or one visit of an end-of-day batch: signs the note, then sends (or saves) the claim.
  async function signAndSend(cl, send) {
    var claimId = newClaimId(), s = snap(cl, claimId), res = { status: 'saved' };
    setNote(cl.note.id, { status: 'Signed', signedAt: new Date().toISOString(), signedBy: me(), cpt: s.cpts[0] ? s.cpts[0].code : '', queuedAt: undefined });
    if (send) {
      try {
        var r = await fetch('/api/billing/claims/transmit', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim: s }) });
        res = await r.json().catch(function () { return {}; });
        if (!r.ok) res = { status: 'error', message: res.detail || res.error };
      } catch (e) { res = { status: 'error', message: 'Althais could not reach the server.' }; }
    }
    var status = res.status === 'sent' ? (res.test ? 'Submitted (Test)' : 'Submitted') : res.status === 'held' ? 'Held' : 'Draft';
    saveRecord(cl, s, status, res.status === 'held' ? { heldReasons: res.blockers || [] } : null);
    res.claimId = claimId; res.amount = cl.amount;
    return res;
  }
  // End of day: the visit waits, unsigned, on the Sign-Off page. No claim exists until it's signed (so nobody can send
  // it from Claims first); the claim is built from the note and codes as they are at sign-off time.
  function queue(cl) { return setNote(cl.note.id, { status: 'Ready to sign', queuedAt: new Date().toISOString() }); }
  function queued() { return read('notes', []).filter(function (n) { return n.status === 'Ready to sign'; }); }

  window.AlthaisClaims = { fees: fees, noteText: noteText, build: build, warnings: warnings, signAndSend: signAndSend, queue: queue, queued: queued,
    hasInsurance: hasInsurance, me: me, POS_NAMES: POS_NAMES, read: read };
})();
