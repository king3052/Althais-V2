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
  window.AltheaHost = { data: data, sections: sections, handoff: handoff };
})();
