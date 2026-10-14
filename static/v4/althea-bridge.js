/* Althea on the v4 preview. static/js/althea.js is the same assistant as everywhere else; this tells her where things
   are here: the preview's own data (read from window.D, never written into the EMR's storage), the v4 pages to open,
   and how to carry out chart requests (open a patient, start a visit, allergies, meds) on these pages. */
(function () {
  var S = D.S, me = D.staff(S.clinic.userStaff);
  var u = window.__ALTHAIS_USER__ || {};
  // "my schedule" means the provider you sign as here; with nobody set, the whole practice
  u.provider_name = me ? D.provName(me.id) : '';
  window.__ALTHAIS_PROVIDER_NAME__ = u.provider_name;

  var STATUS = { edits: 'Pending Review', ready: 'Ready to Submit', submitted: 'Submitted', paid: 'Paid', denied: 'Denied' };
  var data = {
    patients: function () { return S.patients.map(function (p) { return { name: p.name, mrn: p.mrn, dob: p.dob, priorAuths: [] }; }); },
    appts: function () { return S.appts.filter(function (a) { return a.visit !== 'Cancelled'; }).map(function (a) { return { date: a.date, time: a.time, patient: D.ptName(a.mrn), type: a.reason || a.type || 'Visit', provider: D.provName(a.prov) }; }); },
    claims: function () {
      return S.claims.map(function (c) {
        return { claimId: c.id, patient: D.ptName(c.mrn), mrn: c.mrn, provider: D.provName(c.prov), payer: D.payer(c), cpt: (c.lines[0] || {}).code || '', icd: c.dx[0] || '', amount: D.charge(c),
          conf: c.stage === 'edits' ? 70 : 92, status: c.stage === 'denied' && c.dstatus === 'Appealed' ? 'Appealed' : STATUS[c.stage] || c.stage, ts: c.created || c.submittedOn || '', denialReason: c.reason || '', carc: c.carc || '', paid: c.paid || 0, paidOn: c.paidOn || '' };
      });
    },
    notes: function () { return S.encs.map(function (e) { return { id: e.id, mrn: e.mrn, date: e.date, status: e.status, provider: D.provName(e.prov) }; }); },
    payerRules: function () { return D.allRules().map(function (r) { return { payer: r.payer, rule: r.req, effective: r.eff }; }); },
    payerNotes: function () { return []; },
  };
  var sections = {
    overview: '/v4/overview', inbox: '/v4/overview', activity: '/v4/overview', claims: '/v4/revenue/claims', revenue: '/v4/revenue/claims',
    scheduler: '/v4/emr/schedule', schedule: '/v4/emr/schedule', patients: '/v4/emr/patients', soap: '/v4/emr/encounter', emr: '/v4/emr/schedule', settings: '/v4/settings',
    staff: '/v4/staff/team', team: '/v4/staff/team', credentials: '/v4/staff/team', training: '/v4/staff/team', onboarding: '/v4/staff/team', roles: '/v4/settings?s=users', compliance: '/v4/staff/team',
    scribe: '/v4/emr/encounter', code_a_note: '/v4/emr/encounter', coding: '/v4/revenue/claims', denials: '/v4/revenue/denials', appeals: '/v4/revenue/denials',
    payments: '/v4/revenue/claims?q=paid', payer_intelligence: '/v4/revenue/payer-rules', payers: '/v4/revenue/payer-rules', documents: '/v4/emr/documents',
  };

  // which patient a request is about: the one named, else the one on screen
  function findPatient(name) {
    name = String(name || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim();
    if (name) {
      var words = name.split(/\s+/).filter(Boolean);
      var hits = S.patients.filter(function (p) { var n = p.name.toLowerCase(); return words.every(function (w) { return n.indexOf(w) >= 0; }); });
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return { many: hits };
      return null;
    }
    var q = new URLSearchParams(location.search), e = q.get('enc') && D.enc(q.get('enc'));
    return D.pt(q.get('mrn')) || (e && D.pt(e.mrn)) || null;
  }
  function who(params, verb) {
    var p = findPatient(params && params.patient_name);
    if (!p) return { msg: params && params.patient_name ? 'I couldn’t find a patient named ' + params.patient_name + '.' : 'Which patient? Say their name, like "' + verb + ' Walker".' };
    if (p.many) return { msg: p.many.length + ' patients match: ' + p.many.slice(0, 4).map(function (x) { return x.name; }).join('; ') + '. Say the full name.' };
    return { p: p };
  }
  var go = function (href, text) { setTimeout(function () { location.href = href; }, 600); return { text: text, spoken: text, quiet: true }; };
  function handoff(intent, params) {
    if (intent === 'new_patient') { V.patientForm(); return { text: 'The New patient form is open.', spoken: 'Okay, the new patient form is open.' }; }
    if (intent === 'open_patient') { var r = who(params, 'open'); if (!r.p) return { text: r.msg, spoken: r.msg }; return go(V.chartHref(r.p.mrn), 'Opening ' + r.p.name + '.'); }
    if (intent === 'start_visit' || intent === 'scribe_visit' || intent === 'dictate_visit_note') {
      var w = who(params, 'start a visit for'); if (!w.p) return { text: w.msg, spoken: w.msg };
      setTimeout(function () { V.startVisit(w.p.mrn); }, 600); return { text: 'Opening ' + w.p.name + '’s visit. Then say "scribe this visit" to record it.', spoken: 'Opening the visit.', quiet: true };
    }
    if (intent === 'read_allergies' || intent === 'read_medications' || intent === 'read_labs') {
      var x = who(params, 'read allergies for'); if (!x.p) return { text: x.msg, spoken: x.msg };
      var list = intent === 'read_allergies' ? V.lines(x.p.allergies) : intent === 'read_medications' ? V.lines(x.p.meds) : S.encs.filter(function (e) { return e.mrn === x.p.mrn; }).reduce(function (a, e) { return a.concat((e.orders || []).filter(function (o) { return o.type === 'Lab'; }).map(function (o) { return o.name + ' (' + o.status.toLowerCase() + ')'; })); }, []);
      var what = intent === 'read_allergies' ? 'allergies' : intent === 'read_medications' ? 'medications' : 'lab orders';
      var t = list.length ? x.p.name + '’s ' + what + ': ' + list.join('; ') + '.' : 'No ' + what + ' on file for ' + x.p.name + '.';
      return { text: t, spoken: t };
    }
    if (intent === 'start_visit_timer' || intent === 'stop_visit_timer') { var m = 'Open the visit first, then say "scribe this visit" or "stop the visit".'; return { text: m, spoken: m }; }
    if (intent === 'check_claim_readiness' || intent === 'claims_denial_scan') {
      var ed = D.stage('edits'), dn = D.stage('denied');
      var s = ed.length + ' claim' + (ed.length === 1 ? '' : 's') + ' need an edit resolved and ' + D.stage('ready').length + ' ' + (D.stage('ready').length === 1 ? 'is' : 'are') + ' ready to submit. ' + dn.length + ' open denial' + (dn.length === 1 ? '' : 's') + '.';
      return go('/v4/revenue/claims', s + ' Opening Claims.');
    }
    return null;
  }
  // "build the claim", "get this claim to 90%", "fix the claim": Althea builds it on the page; the provider approves
  // "Book Maria Rivera tomorrow at 2:30 for diabetes follow-up": Althea reads the request and opens the appointment form
  // filled in; the person checks it and clicks Book. Nothing is booked without them.
  var DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  V.parseBooking = function (t) {
    var raw = String(t || ''), low = raw.toLowerCase(), out = {}, m, today = new Date(D.today() + 'T12:00:00');
    var iso = function (d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
    // date
    if (/\btoday\b/.test(low)) out.date = iso(today);
    else if (/\btomorrow\b/.test(low)) { var d1 = new Date(today); d1.setDate(d1.getDate() + 1); out.date = iso(d1); }
    else if ((m = low.match(/\b(next\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\b/))) {
      var want = DAYS.findIndex(function (d) { return d.indexOf(m[2].slice(0, 3)) === 0; }), d2 = new Date(today), add = (want - d2.getDay() + 7) % 7 || 7;
      if (m[1]) add += add < 7 ? 7 : 0; d2.setDate(d2.getDate() + add); out.date = iso(d2);
    } else if ((m = low.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
      var y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear(); out.date = y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    } else if ((m = low.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/))) {
      var mo = MONTHS.indexOf(m[1].slice(0, 3)), d3 = new Date(today.getFullYear(), mo, +m[2]); if (d3 < today) d3.setFullYear(d3.getFullYear() + 1); out.date = iso(d3);
    }
    // time
    if ((m = low.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/)) || (m = low.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/)) || (m = low.match(/\b(\d{1,2}):(\d{2})\b/))) {
      var h = +m[1], mi = m[2] ? +m[2] : 0, ap = (m[3] || '').replace(/\./g, '');
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && h >= 1 && h <= 6) h += 12;   // "at 2" in a clinic means 2 PM
      out.time = ('0' + h).slice(-2) + ':' + ('0' + (Math.round(mi / 15) * 15 % 60)).slice(-2);
    }
    if (/\bnoon\b/.test(low)) out.time = '12:00';
    // visit type and reason
    out.type = /new patient|new pt\b/.test(low) ? 'New patient' : /tele(health|visit|med)|video visit/.test(low) ? 'Telehealth' : /annual|wellness|physical/.test(low) ? 'Annual wellness' : /procedure/.test(low) ? 'Procedure' : 'Office visit';
    if ((m = raw.match(/\b(?:for|re:?|reason:?)\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:on|at|with)\s+(?:dr\.?|today|tomorrow|\d|mon|tue|wed|thu|fri|sat|sun|next).*)?[.!]?$/i))) out.reason = m[1].replace(/\b(today|tomorrow|at \d.*|on \w+day.*)$/i, '').trim();
    // provider: "with Dr. Morgan"
    if ((m = low.match(/\bwith\s+(?:dr\.?\s+)?([a-z]+)/))) { var pv = D.providers().filter(function (s) { return s.name.toLowerCase().indexOf(m[1]) >= 0; })[0]; if (pv) out.prov = pv.id; }
    // patient: the one whose last and first names both appear, or a unique last name
    var words = low.replace(/[^a-z ]/g, ' ').split(/\s+/);
    var score = function (p) { var n = p.name.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); return n.filter(function (w) { return w.length > 1 && words.indexOf(w) >= 0; }).length; };
    var ranked = S.patients.filter(function (p) { return p.status !== 'Inactive'; }).map(function (p) { return [score(p), p]; }).filter(function (x) { return x[0] > 0; }).sort(function (a, b) { return b[0] - a[0]; });
    if (ranked.length && (ranked.length === 1 || ranked[0][0] > ranked[1][0])) out.mrn = ranked[0][1].mrn;
    else if (ranked.length > 1) out.many = ranked.slice(0, 4).map(function (x) { return x[1].name; });
    if (out.reason && out.mrn) { var pn = (D.pt(out.mrn).name || '').toLowerCase().replace(',', ''); out.reason = out.reason.split(/\s+/).filter(function (w) { return pn.indexOf(w.toLowerCase()) < 0; }).join(' ') || out.reason; }
    if (out.reason) out.reason = out.reason.charAt(0).toUpperCase() + out.reason.slice(1);
    return out;
  };
  // "New patient Maria Rivera, DOB 4/18/1962, female, Aetna PPO W2840, (512) 555-0142, tomorrow at 10 for knee pain"
  V.parseNewPatient = function (t) {
    var raw = String(t || '').replace(/^\s*(?:please\s+)?(?:add|create|register|new)\s+(?:a\s+)?(?:new\s+)?patient[:,]?\s*/i, ''), low = raw.toLowerCase(), o = {}, m;
    var dob = raw.match(/\b(?:dob|d\.o\.b\.?|born|birth ?date|date of birth)[:\s]*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i) || raw.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-]((?:19|20)\d{2})\b/);
    var md = raw.match(/\b(?:dob|born|birth ?date|date of birth)?[:\s]*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/i);
    if (!dob && md) dob = [md[0], String(MONTHS.indexOf(md[1].toLowerCase().slice(0, 3)) + 1), md[2], md[3]];
    if (dob) { var y = dob[3].length === 2 ? (+dob[3] > +String(new Date().getFullYear()).slice(2) ? '19' : '20') + dob[3] : dob[3]; o.dob = y + '-' + ('0' + dob[1]).slice(-2) + '-' + ('0' + dob[2]).slice(-2); }
    if (/\b(female|woman|girl)\b|\bsex[:\s]*f\b|\bF\b/.test(raw)) o.sex = 'F'; else if (/\b(male|man|boy)\b|\bsex[:\s]*m\b|\bM\b/.test(raw)) o.sex = 'M';
    if ((m = raw.match(/\(?\b(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})\b/))) o.phone = '(' + m[1] + ') ' + m[2] + '-' + m[3];
    if ((m = raw.match(/[\w.+-]+@[\w-]+\.[\w.]+/))) o.email = m[0];
    var payer = D.PAYERS.filter(function (x) { return low.indexOf(x.toLowerCase().replace('.', '')) >= 0 || low.indexOf(x.toLowerCase().split(' ')[0]) >= 0 && x !== 'Self-pay'; })[0] || (/self[- ]?pay|no insurance|uninsured/.test(low) ? 'Self-pay' : '');
    if (/united ?health|uhc/.test(low)) payer = 'UHC';
    if (payer) o.payer = payer;
    if ((m = raw.match(/\b(?:member(?:\s*id)?|id|policy|subscriber(?:\s*id)?)[\s#:]*([A-Z0-9-]{4,})/i)) || (payer && (m = raw.match(new RegExp(payer.split(' ')[0].replace('.', '\\.') + '[^,;]*?\\b((?=[A-Z0-9-]*\\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{6,})\\b', 'i'))))) o.member = m[1].toUpperCase();
    // the name: "Last, First" or the leading words before the first comma/number/keyword
    if ((m = raw.match(/^\s*([A-Za-z'’-]+),\s*([A-Za-z'’-]+)/))) o.name = m[1] + ', ' + m[2];
    else if ((m = raw.match(/^\s*([A-Za-z'’-]+(?:\s+[A-Za-z'’-]+){1,2}?)(?=\s*(?:,|\bdob\b|\bborn\b|\d|\bmale\b|\bfemale\b|$))/i))) o.name = V.splitName(m[1].replace(/\b(?:dob|born)\b.*$/i, '').trim());
    if (o.name) o.name = o.name.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    // a visit in the same request ("tomorrow at 10 for knee pain"): only once the DOB is taken out
    var rest = dob ? raw.replace(dob[0], ' ') : raw, bk = /\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\d{1,2}(:\d{2})?\s*(am|pm)|at \d|next week|appointment|visit)\b/i.test(rest) ? V.parseBooking(rest) : {};
    if (bk.date || bk.time) { delete bk.mrn; delete bk.many; o.visit = bk; }
    return o;
  };
  // Althea does it: creates the patient and books the visit herself, asks for anything she needs, and can undo it
  var PENDING = null, LAST = null;
  function makePatient(o) {
    var p = { name: o.name, dob: o.dob, sex: o.sex || 'X', phone: o.phone || '', email: o.email || '', addr: '', payer: o.payer || '', member: o.member || '',
      pcp: (V.myProvider() || {}).id || '', balance: 0, allergies: '', problems: '', meds: '', status: 'New', created: D.today() };
    p.mrn = D.nextMrn(p.name); S.patients.push(p); D.log('Patient added by Althea: ' + p.name); return p;
  }
  function makeAppt(mrn, b) {
    var prov = b.prov || (V.myProvider() || D.providers()[0] || {}).id;
    if (!prov) return { err: 'There’s no provider to book with yet. Add one in Staff › Team.' };
    var clash = S.appts.filter(function (x) { return x.date === b.date && x.time === b.time && x.prov === prov && x.visit !== 'Cancelled'; })[0];
    if (clash) return { err: D.provName(prov) + ' already has ' + D.ptName(clash.mrn) + ' at ' + V.fmtT(b.time) + ' on ' + D.us(b.date) + '. What time instead?' };
    var a = { id: D.id('A'), mrn: mrn, date: b.date, time: b.time, prov: prov, type: b.type || 'Office visit', reason: b.reason || 'Visit', visit: 'Scheduled' };
    S.appts.push(a); D.log('Appointment booked by Althea: ' + D.ptName(mrn) + ', ' + D.us(b.date) + ' ' + V.fmtT(b.time)); return { a: a };
  }
  function finishPatient(o) {
    var need = !o.name ? 'What’s the patient’s full name?' : !o.dob ? 'What’s ' + o.name.split(', ').reverse().join(' ') + '’s date of birth?' : '';
    if (need) { PENDING = { kind: 'patient', o: o }; return { text: need, spoken: need }; }
    var dup = S.patients.filter(function (p) { return p.name.toLowerCase() === o.name.toLowerCase() && p.dob === o.dob; })[0];
    var p = dup || makePatient(o), done = [dup ? p.name + ' is already a patient (' + p.mrn + ')' : 'Added ' + p.name + ' (' + p.mrn + '), born ' + D.us(p.dob) + (p.payer ? ', ' + p.payer + (p.member ? ' ' + p.member : '') : ', no insurance on file')];
    LAST = { mrn: dup ? null : p.mrn, appt: null };
    if (o.visit && (o.visit.date || o.visit.time)) {
      if (!o.visit.date || !o.visit.time) { PENDING = { kind: 'booking', b: Object.assign({}, o.visit, { mrn: p.mrn }) }; D.save(); if (V.refresh) V.refresh();
        var q = done[0] + '. What ' + (!o.visit.date ? 'day' : 'time') + ' should I book the visit?'; return { text: q, spoken: q }; }
      var r = makeAppt(p.mrn, o.visit);
      if (r.err) { PENDING = { kind: 'booking', b: Object.assign({}, o.visit, { mrn: p.mrn, time: '' }) }; done.push(r.err); }
      else { LAST.appt = r.a.id; done.push('Booked ' + D.us(r.a.date) + ' at ' + V.fmtT(r.a.time) + ' with ' + D.provName(r.a.prov) + (o.visit.reason ? ' for ' + o.visit.reason : '')); }
    }
    D.save(); if (V.refresh) V.refresh();
    var text = done.join('. ') + '. Say “undo” to take it back.';
    return { text: text, spoken: done.join('. ') + '.' };
  }
  function finishBooking(b) {
    if (!b.mrn) { PENDING = { kind: 'booking', b: b }; var q1 = b.many ? 'Which patient: ' + b.many.join(', or ') + '?' : 'Which patient is this for?'; return { text: q1, spoken: q1 }; }
    if (!b.date || !b.time) { PENDING = { kind: 'booking', b: b }; var q2 = 'What ' + (!b.date && !b.time ? 'day and time' : !b.date ? 'day' : 'time') + ' for ' + D.ptName(b.mrn) + '?'; return { text: q2, spoken: q2 }; }
    var r = makeAppt(b.mrn, b);
    if (r.err) { PENDING = { kind: 'booking', b: Object.assign({}, b, { time: '' }) }; return { text: r.err, spoken: r.err }; }
    LAST = { mrn: null, appt: r.a.id }; D.save(); if (V.refresh) V.refresh();
    var t2 = 'Booked ' + D.ptName(b.mrn) + ' on ' + D.us(r.a.date) + ' at ' + V.fmtT(r.a.time) + ' with ' + D.provName(r.a.prov) + (b.reason ? ' for ' + b.reason : '') + '.';
    return { text: t2 + ' Say “undo” to cancel it.', spoken: t2 };
  }
  // an answer to Althea's question fills in what was missing
  function answer(t) {
    if (!PENDING) return null;
    if (/^\s*(cancel|never ?mind|stop|forget it)\b/i.test(t)) { PENDING = null; return { text: 'Okay, cancelled.', spoken: 'Okay.' }; }
    var pend = PENDING; PENDING = null;
    if (pend.kind === 'patient') {
      var add = V.parseNewPatient('new patient ' + t), o = pend.o;
      ['name', 'dob', 'sex', 'phone', 'email', 'payer', 'member'].forEach(function (k) { if (!o[k] && add[k]) o[k] = add[k]; });
      if (!o.name && !add.dob && /^[a-z'’ -]{3,40}$/i.test(t.trim())) o.name = V.splitName(t.trim()).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      if (add.visit && !o.visit) o.visit = add.visit;
      return finishPatient(o);
    }
    var b = pend.b, more = V.parseBooking('book ' + t);
    ['date', 'time', 'reason', 'prov'].forEach(function (k) { if (!b[k] && more[k]) b[k] = more[k]; });
    if (!b.mrn && more.mrn) b.mrn = more.mrn;
    if (!b.time && /^\s*\d{1,2}(:\d{2})?\s*$/.test(t)) b.time = V.parseBooking('at ' + t.trim()).time;
    return finishBooking(b);
  }
  function undo(t) {
    if (!/^\s*(undo|undo that|take (it|that) back|cancel that)\s*[.!]?\s*$/i.test(t)) return null;
    if (!LAST) return { text: 'There’s nothing for me to undo.', spoken: 'Nothing to undo.' };
    var bits = [];
    if (LAST.appt) { S.appts = D.S.appts = S.appts.filter(function (a) { return a.id !== LAST.appt; }); bits.push('removed the appointment'); }
    if (LAST.mrn && !S.encs.some(function (e) { return e.mrn === LAST.mrn; })) { var nm = D.ptName(LAST.mrn); S.patients = D.S.patients = S.patients.filter(function (p) { return p.mrn !== LAST.mrn; }); bits.push('removed ' + nm); }
    LAST = null; D.save(); if (V.refresh) V.refresh();
    var t3 = 'Done, I ' + (bits.join(' and ') || 'changed nothing') + '.'; return { text: t3, spoken: t3 };
  }
  function newPatient(t) {
    if (!/^\s*(?:please\s+)?(?:(?:add|create|register|make)\s+(?:a\s+)?(?:new\s+)?patient|new\s+patient)\b/i.test(t)) return null;
    return finishPatient(V.parseNewPatient(t));
  }
  function booking(t) {
    if (!/^\s*(?:please\s+)?(?:book|schedule|set up|make|add)\b[^.?!]*\b(?:appointment|appt|visit|follow[- ]?up|for|at|tomorrow|today|on)\b|^\s*book\b/i.test(t)) return null;
    return finishBooking(V.parseBooking(t));
  }
  function local(t) {
    var un = undo(t); if (un) return un;
    var an = answer(t); if (an) return an;
    var np = newPatient(t); if (np) return np;
    var bk = booking(t); if (bk) return bk;
    if (!/\b(build|prepare|make|fix|finish|optimi[sz]e|clean ?up|get)\b[^.?!]*\bclaim\b|\bclaim\b[^.?!]*\b(90|ninety|ready|accepted|acceptance)\b/i.test(t)) return null;
    var c = V.ctx || {}, e = c.enc && D.enc(c.enc), cl = c.claim && D.claim(c.claim);
    if (e) { setTimeout(function () { V.buildClaim({ enc: e }, V.refresh); }, 200); return { text: 'Building the claim from this visit. I’ll get it to 90% or better from what’s documented, then you approve it.', spoken: 'Building the claim. You’ll approve it when it’s ready.' }; }
    if (cl) { setTimeout(function () { V.buildClaim({ claim: cl }, V.refresh); }, 200); return { text: 'Working on ' + cl.id + '. I’ll get it to 90% or better, then you approve it.', spoken: 'Working on the claim.' }; }
    return { text: 'Open a visit or a claim first, then ask me to build the claim.', spoken: 'Open a visit or a claim first.' };
  }
  window.AltheaHost = { data: data, sections: sections, handoff: handoff, local: local };
})();
