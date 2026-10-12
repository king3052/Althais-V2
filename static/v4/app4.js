/* v4: the AI and billing tools from the previous EMR, brought into the new one.
   - Claim check: acceptance likelihood (0 to 100) with flags and missing items, from /api/validate-claim
   - CMS-1500: the claim as the paper form, printable
   - Sending: the 837P transmission steps, then the server's claim gate (/api/billing/claims/transmit) decides sent or held
   - AI appeal letter (/api/appeal-letter), Code a Note (paste a note, get codes, check, make a claim)
   - Sample clinic: example patients, a visit and claims so every screen can be tried */
(function () {
  var E = U.esc, M = U.money, S = D.S;

  var desc = function (code) { var f = S.fees.filter(function (x) { return x.code === code; })[0]; return f ? f.desc : ''; };
  // the claim in the shape the server's claim gate and claim check read
  V.claimSnap = function (c) {
    var p = D.pt(c.mrn) || {}, e = D.enc(c.encId), prov = D.staff(c.prov) || {};
    var ec = e ? e.codes : [], dsc = function (code) { var x = ec.filter(function (y) { return y.code === code; })[0]; return (x && x.desc) || desc(code); };
    return { claimId: c.id, patient: p.name || '', mrn: c.mrn, dob: p.dob || '', sex: p.sex || '', provider: prov.name || '', npi: prov.npi || '', payer: D.payer(c), svcDate: c.dos, pos: '11',
      addrStreet: p.addr || '', addrPhone: p.phone || '', insuredId: p.member || '',
      cpts: c.lines.map(function (l) { return { code: l.code, description: dsc(l.code), type: 'CPT', modifier: l.mod || '', units: l.units || 1, charge: D.fee(l.code) * (l.units || 1) }; }),
      icds: c.dx.map(function (d) { return { code: d, description: dsc(d), type: 'ICD-10' }; }),
      totalAmt: D.charge(c), note: e ? D.noteText(e) : (c.note || ''), billing: { name: S.clinic.name, npi: S.clinic.npi, ein: S.clinic.ein, addr: S.clinic.addr, city: S.clinic.city, phone: S.clinic.phone } };
  };

  /* ---------- claim check: likelihood of acceptance ---------- */
  V.scoreColor = function (s) { return s >= 85 ? 'grn' : s >= 65 ? 'amb' : 'red'; };
  V.claimCheck = function (c) {
    var snap = V.claimSnap(c);
    return fetch('/api/validate-claim', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: snap.cpts.concat(snap.icds).map(function (x) { return { code: x.code, description: x.description, type: x.type }; }),
        note: 'CLAIM: patient ' + (snap.patient || 'not on file') + ', DOB ' + (snap.dob || 'not on file') + ', sex ' + (snap.sex || 'not on file') + ', payer ' + (snap.payer || 'not on file') + ', member ID ' + (snap.insuredId || 'not on file') + ', rendering provider ' + (snap.provider || 'not on file') + ', date of service ' + (snap.svcDate || 'not on file') + ', place of service 11.\n\n' + snap.note }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j, s: r.status }; }); })
      .then(function (x) {
        if (!x.ok || x.j.error) throw new Error(x.s === 403 ? 'Your plan or role doesn’t include the claim check.' : x.s === 401 ? 'Log in again to run the claim check.' : 'The claim check is unavailable right now.');
        c.check = { score: Math.max(0, Math.min(100, Number(x.j.score) || 0)), flags: x.j.flags || [], missing: x.j.missing || [], at: new Date().toISOString() };
        D.history(c, 'Claim check: ' + c.check.score + '% likely to be accepted'); D.save(); return c.check;
      });
  };
  V.checkHtml = function (c, busy, err) {
    var k = c.check;
    var head = '<div class="dp-h">Claim check <span class="sub">likelihood of acceptance</span><span class="end"><button class="mini" data-runcheck="' + c.id + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Checking…' : k ? 'Re-check' : 'Run claim check') + '</button></span></div>';
    if (err) return '<div class="dp-sec">' + head + '<div class="s-red">' + E(err) + '</div></div>';
    if (!k) return '<div class="dp-sec">' + head + '<div class="mut">' + (busy ? 'Reading the note and codes…' : 'Checks medical necessity, E/M level support, modifiers, specificity, required fields and NCCI bundling before you send.') + '</div></div>';
    var col = V.scoreColor(k.score);
    return '<div class="dp-sec">' + head +
      '<div style="display:flex;align-items:center;gap:12px"><b class="s-' + col + '" style="font-size:22px;font-weight:600">' + k.score + '%</b><div style="flex:1"><div style="height:6px;background:var(--b2)"><div style="height:6px;width:' + k.score + '%;background:var(--' + col + ')"></div></div>' +
      '<div class="mut" style="font-size:12px;margin-top:3px">' + (k.score >= 85 ? 'Ready to submit' : k.score >= 65 ? 'Usable, with some risk' : 'Not ready, significant issues') + ' · checked ' + new Date(k.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</div></div></div>' +
      (k.missing.length ? '<div class="ok-list" style="margin-top:6px">' + k.missing.map(function (m) { return '<div class="e">' + U.err + 'Missing: ' + E(m) + '</div>'; }).join('') + '</div>' : '') +
      (k.flags.length ? '<div class="ok-list">' + k.flags.map(function (f) { return '<div class="w">' + U.warn + E(f) + '</div>'; }).join('') + '</div>' : '') + '</div>';
  };
  // any page: buttons with data-runcheck run the check and redraw
  var checking = {}, checkErr = {};
  V.checkState = function (id) { return { busy: !!checking[id], err: checkErr[id] || '' }; };
  U.on(document.body, '[data-runcheck]', 'click', function (b) {
    var c = D.claim(b.dataset.runcheck); if (!c) return;
    checking[c.id] = true; delete checkErr[c.id]; V.refresh();
    V.claimCheck(c).catch(function (e) { checkErr[c.id] = e.message; }).then(function () { delete checking[c.id]; V.refresh(); });
  });

  /* ---------- CMS-1500 ---------- */
  V.cms1500 = function (c) {
    var s = V.claimSnap(c), p = D.pt(c.mrn) || {};
    var box = function (n, label, val, span) { return '<div class="cms-b" style="grid-column:span ' + (span || 1) + '"><span>' + n + '. ' + E(label) + '</span><b>' + (val ? E(val) : '&nbsp;') + '</b></div>'; };
    var html = '<div class="cms" id="cms"><div class="cms-top"><b>HEALTH INSURANCE CLAIM FORM</b><span>APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12 · FORM CMS-1500 (02-12)</span></div>' +
      '<div class="cms-g">' + box('1', 'Insurance', s.payer, 2) + box('1a', 'Insured’s ID number', s.insuredId, 2) +
        box('2', 'Patient’s name', s.patient, 2) + box('3', 'Birth date, sex', D.us(s.dob) + '  ' + s.sex, 1) + box('4', 'Insured’s name', s.patient, 1) +
        box('5', 'Patient’s address', p.addr || '', 2) + box('7', 'Insured’s phone', p.phone || '', 2) +
        box('17', 'Referring provider', '', 2) + box('17b', 'NPI', '', 2) +
        box('21', 'Diagnosis (ICD-10)', s.icds.map(function (d, i) { return String.fromCharCode(65 + i) + '. ' + d.code; }).join('   '), 4) + '</div>' +
      '<table class="cms-t"><thead><tr><th>24A. DOS</th><th>B. POS</th><th>D. CPT/HCPCS</th><th>Modifier</th><th>E. Dx ptr</th><th>F. Charges</th><th>G. Units</th><th>J. Rendering NPI</th></tr></thead><tbody>' +
        s.cpts.map(function (l) { return '<tr><td>' + D.us(s.svcDate) + '</td><td>11</td><td>' + E(l.code) + '</td><td>' + E(l.modifier || '') + '</td><td>' + s.icds.slice(0, 4).map(function (_, i) { return String.fromCharCode(65 + i); }).join('') + '</td><td>' + M(l.charge) + '</td><td>' + l.units + '</td><td>' + E(s.npi || '') + '</td></tr>'; }).join('') +
        '</tbody></table><div class="cms-g">' + box('25', 'Federal tax ID', S.clinic.ein, 1) + box('26', 'Patient account no.', s.mrn, 1) + box('28', 'Total charge', M(s.totalAmt), 1) + box('29', 'Amount paid', M(c.paid || 0), 1) +
        box('31', 'Signature of physician', s.provider + '  ' + D.us(c.dos), 2) + box('32', 'Service facility', (S.locations[0] || {}).name || S.clinic.name, 1) + box('33', 'Billing provider, NPI', S.clinic.name + (S.clinic.npi ? '  NPI ' + S.clinic.npi : ''), 1) + '</div></div>';
    U.modal('CMS-1500, ' + c.id, html, [['Close', '', function () {}], ['Print', 'pri', function () {
      var w = window.open(''); w.document.write('<html><head><title>CMS-1500 ' + c.id + '</title><style>' + CMS_CSS + 'body{font:12px Arial;margin:24px}</style></head><body>' + html + '</body></html>'); setTimeout(function () { w.print(); }, 300); return false;
    }]], { wide: 1 });
  };
  var CMS_CSS = '.cms{border:2px solid #b5332a;color:#1c2733}.cms-top{display:flex;justify-content:space-between;align-items:baseline;padding:6px 8px;border-bottom:2px solid #b5332a;color:#b5332a}.cms-top span{font-size:10px}' +
    '.cms-g{display:grid;grid-template-columns:repeat(4,1fr)}.cms-b{border-right:1px solid #e3a8a3;border-bottom:1px solid #e3a8a3;padding:3px 6px;min-height:34px}.cms-b span{display:block;font-size:9.5px;color:#b5332a;text-transform:uppercase}.cms-b b{font-weight:500;font-family:"IBM Plex Mono",monospace;font-size:12px}' +
    '.cms-t{width:100%;border-collapse:collapse}.cms-t th{font-size:9.5px;color:#b5332a;text-align:left;border-bottom:1px solid #e3a8a3;padding:3px 6px;font-weight:600}.cms-t td{font-family:"IBM Plex Mono",monospace;font-size:12px;padding:4px 6px;border-bottom:1px solid #e3a8a3}';
  var st = document.createElement('style'); st.textContent = CMS_CSS; document.head.appendChild(st);

  /* ---------- sending: 837P steps, then the server's claim gate ---------- */
  V.transmit = function (list, done) {
    list = list.filter(function (c) { D.scrub(c); return c.stage === 'ready'; });
    if (!list.length) { U.toast('Nothing ready to send. Resolve the edits first.'); return; }
    var steps = ['Building ANSI X12 837P', 'Validating segments and loops', 'Running the claim gate', 'Transmitting to the clearinghouse', 'Waiting for the 999 acknowledgment'];
    var w = U.modal('Sending ' + list.length + ' claim' + (list.length === 1 ? '' : 's'), '<div id="tx-steps"></div><pre id="tx-edi" class="mono" style="margin:10px 0 0;padding:8px;background:var(--ph);border:1px solid var(--b2);max-height:150px;overflow:auto;font-size:11px;white-space:pre-wrap"></pre><div id="tx-res"></div>', [['Close', '', function () { done && done(); }]], { wide: 1 });
    var c0 = list[0], s0 = V.claimSnap(c0), d = D.today().replace(/-/g, '');
    w.querySelector('#tx-edi').textContent = ['ISA*00*          *00*          *ZZ*ALTHAIS        *ZZ*CLEARINGHOUSE  *' + d.slice(2) + '*1200*^*00501*' + c0.id.replace(/\D/g, '').slice(-9) + '*0*T*:~', 'GS*HC*ALTHAIS*CLEARINGHOUSE*' + d + '*1200*1*X*005010X222A1~', 'ST*837*0001*005010X222A1~',
      'NM1*85*2*' + (S.clinic.name || '').toUpperCase() + '*****XX*' + (S.clinic.npi || '') + '~', 'NM1*IL*1*' + s0.patient.toUpperCase().replace(', ', '*') + '****MI*' + s0.insuredId + '~', 'CLM*' + c0.id + '*' + s0.totalAmt.toFixed(2) + '***11:B:1*Y*A*Y*Y~',
      'HI*' + s0.icds.map(function (x, i) { return (i ? 'ABF:' : 'ABK:') + x.code.replace('.', ''); }).join('*') + '~'].concat(s0.cpts.map(function (l, i) { return 'LX*' + (i + 1) + '~\nSV1*HC:' + l.code + (l.modifier ? ':' + l.modifier : '') + '*' + l.charge.toFixed(2) + '*UN*' + l.units + '***1~'; })).join('\n');
    var paint = function (n) { w.querySelector('#tx-steps').innerHTML = steps.map(function (t, i) { return '<div style="padding:3px 0" class="' + (i < n ? 's-grn' : i === n ? '' : 'mut') + '">' + (i < n ? U.I.check : i === n ? '<span class="dot" style="background:var(--blue);margin-right:7px"></span>' : '<span style="display:inline-block;width:14px"></span>') + E(t) + '</div>'; }).join(''); };
    var n = 0; paint(0);
    var tick = setInterval(function () { if (n < 2) paint(++n); }, 450);
    var results = [];
    (function next(i) {
      if (i >= list.length) {
        clearInterval(tick); paint(steps.length);
        var sent = results.filter(function (r) { return r.res.status === 'sent'; }), held = results.filter(function (r) { return r.res.status === 'held'; }), bad = results.filter(function (r) { return ['sent', 'held'].indexOf(r.res.status) < 0; });
        w.querySelector('#tx-res').innerHTML = '<div class="dp-h" style="margin-top:12px">Result</div>' + results.map(function (r) {
          var st = r.res.status;
          return '<div style="padding:5px 0;border-bottom:1px solid var(--b2)"><b class="mono">' + r.c.id + '</b> ' + E(D.ptName(r.c.mrn)) + ' · ' + M(D.charge(r.c)) + ' · ' +
            (st === 'sent' ? '<span class="s-grn">Sent' + (r.res.test ? ' (test mode)' : '') + (r.res.reference ? ', ref ' + E(r.res.reference) : '') + '</span>' : st === 'held' ? '<span class="s-amb">Held, not sent</span>' + (r.res.blockers || []).map(function (b) { return '<div class="mut" style="font-size:12px">' + E(b.title || '') + ': ' + E(b.reason || '') + (b.next ? ' · ' + E(b.next) : '') + '</div>'; }).join('') : '<span class="s-red">Not sent: ' + E(r.res.message || r.res.detail || 'error') + '</span>') + '</div>';
        }).join('') + (held.length ? '<div class="mut" style="margin-top:6px">Held claims stay in Ready to submit. Finish the items above in <a href="/revenue/billing-activation">Billing activation</a> and send again.</div>' : '');
        w.querySelector('.mdl-h').firstChild.textContent = sent.length + ' sent, ' + held.length + ' held' + (bad.length ? ', ' + bad.length + ' not sent' : '');
        D.log('Sent ' + sent.length + ' claim(s), ' + held.length + ' held'); D.save(); if (done) done();
        return;
      }
      var c = list[i];
      fetch('/api/billing/claims/transmit', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim: V.claimSnap(c) }) })
        .then(function (r) { return r.json().then(function (j) { return r.ok ? j : { status: 'error', message: r.status === 403 ? (j.detail || 'Only billers and clinic admins can send claims.') : (j.detail || j.error || 'The claim could not be checked.') }; }); })
        .catch(function () { return { status: 'error', message: 'Could not reach the server.' }; })
        .then(function (res) {
          if (res.status === 'sent' || res.status === 'already_sent') { c.stage = 'submitted'; c.status = res.test ? 'Submitted (test)' : 'Submitted ' + D.us(D.today(), 1).slice(0, 5); c.submittedOn = D.today(); c.ref = res.reference || ''; D.history(c, 'Sent' + (res.test ? ' in test mode' : '') + (res.reference ? ', ref ' + res.reference : '')); res.status = 'sent'; }
          else if (res.status === 'held') { c.heldReasons = res.blockers || []; D.history(c, 'Held by the claim gate: ' + (res.blockers || []).map(function (b) { return b.title; }).join('; ')); }
          else D.history(c, 'Not sent: ' + (res.message || 'error'));
          results.push({ c: c, res: res }); next(i + 1);
        });
    })(0);
  };

  /* ---------- AI appeal letter ---------- */
  V.aiLetter = function (c) {
    var s = V.claimSnap(c);
    return fetch('/api/appeal-letter', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient: s.patient, mrn: s.mrn, claimId: c.id, svcDate: D.us(c.dos), provider: s.provider, payer: s.payer, cpt: s.cpts.map(function (x) { return x.code; }).join(', '), icd: s.icds.map(function (x) { return x.code; }).join(', '), amount: M(s.totalAmt), status: 'Denied ' + (c.carc || '') + ' ' + (c.reason || ''), practice: S.clinic.name }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(r.status === 403 ? 'Your plan or role doesn’t include appeal drafting.' : 'Appeal drafting is unavailable right now.'); return j.letter; }); });
  };

  /* ---------- Code a Note ---------- */
  V.pages.codenote = function () {
    var app = V.app, st = V.cn || (V.cn = { note: '', codes: [], busy: false, err: '', check: null, mrn: '' });
    function draw() {
      var acc = st.codes.filter(function (c) { return c.on; });
      app.innerHTML = U.header('codenote') + U.toolbar('Code a Note', [['Get codes', 'check', { pri: 1, id: 'go' }], ['Check claim', 'refresh', { id: 'chk' }], ['Create claim', 'plus', { id: 'mk' }], '|', ['Clear', 'x', { id: 'clr' }]], 'Paste any visit note') +
        '<div class="main" style="grid-template-columns:minmax(0,1fr) 470px">' +
          '<section class="pane"><div class="ph">Visit note <span class="sub">paste or type, then Get codes</span></div><div class="pbody" style="padding:10px"><textarea class="ed" id="cn" style="height:100%;min-height:400px" placeholder="Chief complaint, HPI, exam, assessment and plan">' + E(st.note) + '</textarea></div></section>' +
          '<section class="pane"><div class="ph">Codes <span class="sub">' + (st.busy ? 'reading the note…' : st.codes.length + ' suggested') + '</span></div><div class="pbody">' +
            (st.err ? '<div class="banner-note s-red">' + E(st.err) + '</div>' : '') +
            U.grid(['', 'Code', 'Description', ['Conf.', 'num']], st.codes.map(function (c, i) { return { cells: ['<input type="checkbox" data-cc="' + i + '"' + (c.on ? ' checked' : '') + '>', '<b>' + E(c.code) + '</b><div class="mut" style="font-size:11px">' + c.type + '</div>', '<div class="wrap">' + E(c.desc) + '</div><div class="mut wrap" style="font-size:11.5px">' + E(c.why || '') + '</div>' + (c.gap ? '<div class="s-amb wrap" style="font-size:11.5px">' + U.warn + E(c.gap) + '</div>' : ''), '<b class="s-' + (c.conf < 80 ? 'amb' : 'grn') + '">' + c.conf + '%</b>'] }; }), { tight: 1 }).replace('<tbody></tbody>', '<tbody>' + U.empty(4, 'Codes appear here.') + '</tbody>') +
            (st.check ? (function () { var k = st.check, col = V.scoreColor(k.score); return '<div class="dp-sec"><div class="dp-h">Claim check <span class="sub">likelihood of acceptance</span></div><b class="s-' + col + '" style="font-size:22px;font-weight:600">' + k.score + '%</b>' + k.missing.map(function (m) { return '<div class="s-red">' + U.err + 'Missing: ' + E(m) + '</div>'; }).join('') + k.flags.map(function (f) { return '<div class="s-amb">' + U.warn + E(f) + '</div>'; }).join('') + '</div>'; })() : '') +
            '<div class="dp-sec"><div class="dp-h">Make it a claim</div>' + U.fields([{ k: 'mrn', label: 'Patient', type: 'select', options: V.ptOptions(), blank: 'Choose a patient', span: 4 }], { mrn: st.mrn }) + '<div class="mut" style="margin-top:4px">' + acc.length + ' code' + (acc.length === 1 ? '' : 's') + ' checked will go on the claim.</div></div>' +
          '</div></section></div>';
      U.fit(); U.search();
    }
    V.redraw = draw; draw();
    app.addEventListener('input', function (e) { if (e.target.id === 'cn') st.note = e.target.value; });
    app.addEventListener('change', function (e) { if (e.target.dataset.cc != null) st.codes[+e.target.dataset.cc].on = e.target.checked; if (e.target.dataset.k === 'mrn') st.mrn = e.target.value; });
    U.on(app, '#clr', 'click', function () { V.cn = null; st = V.cn = { note: '', codes: [], busy: false, err: '', check: null, mrn: '' }; draw(); });
    U.on(app, '#go', 'click', function () {
      if (st.note.trim().length < 20) return U.toast('Paste a note first.');
      st.busy = true; st.err = ''; st.check = null; draw();
      fetch('/api/code-note', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: st.note, encounter_type: 'office', specialty: 'primary care / outpatient office' }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(r.status === 403 ? 'Your plan or role doesn’t include coding.' : 'Coding is unavailable right now.'); return j; }); })
        .then(function (j) { st.codes = (j.codes || []).map(function (c) { return { code: c.code, desc: c.description || '', type: /CPT/i.test(c.type || '') ? 'CPT' : 'ICD-10', conf: Number(c.confidence) || 0, why: c.justification || '', gap: c.documentation_gap || '', on: true }; }); })
        .catch(function (e) { st.err = e.message; }).then(function () { st.busy = false; draw(); });
    });
    var temp = function () { var acc = st.codes.filter(function (c) { return c.on; }); return { id: 'CHECK', encId: '', mrn: st.mrn, dos: D.today(), prov: '', lines: acc.filter(function (c) { return c.type === 'CPT'; }).map(function (c) { return { code: c.code, units: 1 }; }), dx: acc.filter(function (c) { return c.type !== 'CPT'; }).map(function (c) { return c.code; }), note: st.note, hist: [] }; };
    U.on(app, '#chk', 'click', function () {
      if (!st.codes.length) return U.toast('Get codes first.');
      var c = temp(); st.busy = true; draw();
      var realSave = D.save; D.save = function () {};   // a check here isn't saved anywhere
      V.claimCheck(c).then(function (k) { st.check = k; }).catch(function (e) { st.err = e.message; }).then(function () { D.save = realSave; st.busy = false; draw(); });
    });
    U.on(app, '#mk', 'click', function () {
      if (!st.mrn) return U.toast('Choose the patient.');
      var t = temp(); if (!t.lines.length) return U.toast('Check at least one CPT code.');
      var c = { id: D.nextClaimId(), encId: '', mrn: st.mrn, dos: D.today(), prov: (V.myProvider() || {}).id || '', payer: (D.pt(st.mrn) || {}).payer, lines: t.lines.map(function (l) { return { code: l.code, mod: '', units: 1 }; }), dx: t.dx, note: st.note, stage: 'edits', resolved: {}, created: new Date().toISOString(), check: st.check };
      D.scrub(c); D.history(c, 'Created in Code a Note'); S.claims.push(c); D.log('Claim from Code a Note: ' + c.id); D.save(); location.href = V.claimHref(c.id);
    });
  };

  /* ---------- sample clinic ---------- */
  V.loadSample = function () {
    if (S.patients.some(function (p) { return p.sample; })) return U.toast('The sample clinic is already loaded.');
    var T = D.today(), add = function (n) { return D.addDays(T, n); }, me = V.myProvider();
    var prov = me ? me.id : (function () { var s = { id: D.id('S'), name: 'Sample, Provider', cred: 'MD', provider: true, status: 'Active', access: 'Provider', creds: [], reminders: [], training: [], sample: true }; S.staff.push(s); return s.id; })();
    var P = [['Sample, Robert', '1958-05-03', 'M', 'Medicare B', 'SMP-1EG4TE5MK72', 'Sulfa (rash)', 'E11.22 T2DM with diabetic CKD; I10 Hypertension; N18.31 CKD stage 3a', 'Metformin 500 mg BID\nAmlodipine 5 mg daily'],
      ['Sample, Barbara', '1961-11-22', 'F', 'Aetna PPO', 'SMP-W288104417', '', 'E11.9 Type 2 diabetes', 'Metformin 1000 mg BID'], ['Sample, Marcus', '1970-11-30', 'M', 'UHC', 'SMP-912204558', '', 'I10 Hypertension', 'Lisinopril 20 mg daily'],
      ['Sample, Ashley', '1990-07-30', 'F', 'Cigna', 'SMP-U77120394', 'Penicillin', '', ''], ['Sample, Thomas', '1972-08-16', 'M', 'UHC', 'SMP-913302871', '', '', '']];
    var m = P.map(function (x) { var p = { mrn: D.nextMrn(x[0]), name: x[0], dob: x[1], sex: x[2], payer: x[3], member: x[4], allergies: x[5], problems: x[6], meds: x[7], pcp: prov, balance: 0, status: 'Active', created: T, eligChecked: T, sample: true }; S.patients.push(p); return p.mrn; });
    var e = { id: D.id('E'), mrn: m[0], date: T, prov: prov, visitType: 'Office visit', reason: 'Diabetes and blood pressure follow-up', status: 'Draft', sample: true,
      s: '68M returns for diabetes and blood pressure follow-up. Home BP readings in the 150s despite daily amlodipine. Fasting glucose 140 to 160. Mild ankle swelling in the evenings.',
      o: 'BP 152/94, HR 72. Trace bilateral ankle edema. A1c 7.8%, eGFR 58, urine albumin/creatinine 64.', a: '1. Type 2 diabetes with diabetic CKD, not at goal.\n2. Hypertension, uncontrolled on two agents.\n3. CKD stage 3a, stable.',
      p: 'Increase losartan to 100 mg daily. Start empagliflozin 10 mg. Repeat BMP in 2 weeks. Return in 6 weeks.', vitals: { bp: '152/94', hr: '72' },
      transcript: [{ t: '10:36 AM', text: 'My blood pressure at home has been running around 150, 155 most mornings.' }, { t: '10:39 AM', text: 'Your kidney number, the eGFR, was 58 last month, about the same as spring.' }],
      orders: [{ type: 'Rx', name: 'Losartan 100 mg tab', detail: '1 daily, #90, 1 refill', dx: 'I12.9', status: 'Pending' }, { type: 'Lab', name: 'Basic metabolic panel', detail: 'Due in 2 weeks', dx: 'N18.31', status: 'Pending' }], codes: [], addenda: [], ignored: {} };
    S.encs.push(e);
    S.appts.push({ id: D.id('A'), mrn: m[0], date: T, time: '10:30', prov: prov, reason: 'DM, HTN follow-up', type: 'Office visit', visit: 'In room', room: 'Exam 2', encId: e.id, sample: true });
    S.appts.push({ id: D.id('A'), mrn: m[4], date: T, time: '15:00', prov: prov, reason: 'Knee pain', type: 'Office visit', visit: 'Scheduled', sample: true });
    var e2 = { id: D.id('E'), mrn: m[1], date: T, prov: prov, visitType: 'Office visit', status: 'Signed', signedAt: new Date().toISOString(), signedBy: S.clinic.user, sample: true, s: 'Diabetes check. Home sugars 140s.', o: 'BP 138/84.', a: 'Type 2 diabetes', p: 'Continue metformin.', vitals: {},
      transcript: [{ t: '10:31 AM', text: 'Let me check your feet. Can you feel this? Good, both sides. No sores, pulses are strong.' }], orders: [], codes: [], addenda: [], ignored: {} };
    S.encs.push(e2);
    var mk = function (mrn, cpt, dx, stage, extra) { var c = Object.assign({ id: D.nextClaimId(), mrn: mrn, dos: T, prov: prov, payer: D.pt(mrn).payer, lines: cpt.map(function (x) { return { code: x, mod: '', units: 1 }; }), dx: dx, stage: stage, resolved: {}, created: new Date().toISOString(), sample: true }, extra || {}); if (stage === 'edits' || stage === 'ready') D.scrub(c); D.history(c, 'Sample claim'); S.claims.push(c); return c; };
    mk(m[1], ['99214'], ['E11.9'], 'edits', { encId: e2.id });
    mk(m[3], ['99213'], ['J06.9'], 'ready');
    mk(m[2], ['99214'], ['I10'], 'submitted', { submittedOn: add(-2), status: 'Accepted 277CA', dos: add(-3) });
    mk(m[3], ['99213'], ['R10.9'], 'paid', { submittedOn: add(-9), paidOn: add(-1), paid: 92.4, dos: add(-10) });
    mk(m[4], ['73721'], ['M25.561'], 'denied', { submittedOn: add(-10), dos: add(-12), carc: 'CO-197', reason: 'Prior auth absent', appealBy: add(24), dstatus: 'Needs review', everDenied: true });
    D.log('Sample clinic loaded'); D.save(); U.toast('Sample clinic loaded: 5 patients, 2 visits, 5 claims. Remove it in Settings › Security and data.'); V.refresh();
  };
  V.clearSample = function () {
    ['patients', 'appts', 'encs', 'claims'].forEach(function (k) { S[k] = S[k].filter(function (x) { return !x.sample; }); });
    S.staff = S.staff.filter(function (x) { return !x.sample; }); D.log('Sample clinic removed'); D.save(); V.refresh(); U.toast('Sample clinic removed.');
  };
})();
