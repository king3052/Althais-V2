/* v4 working preview, part 7: New Patient › Scan To Autofill (patient_intake.py).
   New Patient asks: scan documents to autofill, or enter manually (the existing form, unchanged). Scanning uploads the
   insurance card, photo ID and intake forms (encrypted on the server), Claude reads them, and a review screen shows the
   registration form pre-filled next to the documents: yellow = low confidence, red = documents disagree. Every field is
   editable, and nothing is saved until Confirm & Create Patient. The person can switch to manual entry at any point and
   keeps whatever is already filled in. */
(function () {
  var E = U.esc, S = D.S;
  var manualForm = V.patientForm;   // the existing form, untouched
  var TAGS = [['insurance_front', 'Insurance card front'], ['insurance_back', 'Insurance card back'], ['photo_id', 'Photo ID'], ['intake_form', 'Intake form'], ['consent_other', 'Consent/other']];
  var SECTIONS = [
    ['Patient', [['first_name', 'First name', 1], ['middle_name', 'Middle name'], ['last_name', 'Last name', 1], ['date_of_birth', 'Date of birth', 1, 'date'], ['sex', 'Sex', 0, 'sex'],
      ['phone', 'Phone'], ['email', 'Email'], ['address_street', 'Street address', 0, 0, 2], ['address_city', 'City'], ['address_state', 'State'], ['address_zip', 'ZIP'],
      ['emergency_contact_name', 'Emergency contact'], ['emergency_contact_phone', 'Emergency phone']]],
    ['Insurance', [['payer_name', 'Payer'], ['member_id', 'Member ID'], ['group_number', 'Group number'], ['plan_name', 'Plan'], ['subscriber_name', 'Subscriber'],
      ['subscriber_date_of_birth', 'Subscriber DOB', 0, 'date'], ['relationship_to_patient', 'Relationship to patient'], ['payer_phone', 'Payer phone'], ['rx_bin', 'RxBIN'], ['rx_pcn', 'RxPCN']]],
    ['From The Intake Form', [['medications', 'Medications', 0, 'list', 2], ['allergies', 'Allergies', 0, 'list', 2], ['medical_history', 'Medical history', 0, 'list', 2],
      ['preferred_pharmacy', 'Preferred pharmacy'], ['referring_provider', 'Referring provider']]]];
  var LISTS = { medications: 1, allergies: 1, medical_history: 1 };
  var STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP'.split(' ');

  function api(method, url, body, form) {
    return fetch(url, { method: method, credentials: 'same-origin', headers: body && !form ? { 'Content-Type': 'application/json' } : {}, body: form || (body ? JSON.stringify(body) : undefined) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.detail || j.error || 'Something went wrong.'); return j; }); });
  }
  var guessTag = function (name) { var n = String(name || '').toLowerCase(); return /back/.test(n) ? 'insurance_back' : /front|card|insur/.test(n) ? 'insurance_front' : /licen|\bid\b|_id|dl\b|passport/.test(n) ? 'photo_id' : /consent|hipaa|release/.test(n) ? 'consent_other' : /intake|form|registr|history/.test(n) ? 'intake_form' : 'insurance_front'; };

  // ---------- 1. the choice ----------
  V.patientForm = function (p, after, preset) {
    if (p || preset) return manualForm(p, after, preset);   // editing, or a form someone already filled: unchanged
    var w = U.modal('New Patient', '<div class="pi-choice">' +
      '<button type="button" class="pi-opt pri" data-pi="scan"><b>' + U.I.upload + 'Scan Documents To Autofill</b><span>Insurance card, photo ID or intake form. Althea reads them; you review every field before anything is saved.</span></button>' +
      '<button type="button" class="pi-opt" data-pi="manual"><b>' + U.I.pencil + 'Enter Manually</b><span>The regular registration form.</span></button></div>', [['Cancel', '', function () {}]], { width: 560 });
    w.addEventListener('click', function (e) { var b = e.target.closest('[data-pi]'); if (!b) return; w.remove();
      if (b.dataset.pi === 'manual') manualForm(null, after); else scan(after); });
  };

  // ---------- 2. upload ----------
  function scan(after, state) {
    var st = state || { intakeId: '', docs: [], values: {} };
    var w = U.modal('Scan To Autofill', '', [['Cancel', '', function () {}], ['Enter Manually Instead', '', function () { toManual(st, after); }],
      ['Read Documents', 'pri', function () { if (!st.docs.length) { U.toast('Add a document first.', 'warn'); return false; }
        (st.q || Promise.resolve()).then(function () { if (st.docs.some(function (d) { return d.id; })) read(st, after, w); else U.toast('None of the documents uploaded. Try again or enter the patient manually.', 'warn'); }); return false; }]], { width: 860 });
    var body = w.querySelector('.mdl-b');
    var draw = function () {
      body.innerHTML = '<div class="pi-drop" id="pi-drop"><div class="pi-dicon">' + U.I.upload + '</div><b>Drop files here</b><span>JPG, PNG, HEIC or PDF, from a desk scanner, the computer or a phone.</span>' +
        '<div class="pi-btns"><label class="btn">' + U.I.clip + 'Choose Files<input type="file" id="pi-files" multiple accept="image/*,.heic,.heif,application/pdf" hidden></label>' +
        '<label class="btn">' + U.I.upload + 'Use Camera<input type="file" id="pi-cam" accept="image/*" capture="environment" hidden></label></div></div>' +
        (st.docs.length ? '<div class="pi-list">' + st.docs.map(function (d, i) {
          return '<div class="pi-item"><div class="pi-thumb">' + (d.preview ? '<img src="' + d.preview + '" alt="">' : '<span>' + (d.ct === 'application/pdf' ? 'PDF' : 'File') + '</span>') + '</div>' +
            '<div class="pi-meta"><b>' + E(d.name) + '</b><small>' + (d.error ? '<span class="s-red">' + E(d.error) + '</span>' : d.id ? 'Uploaded, encrypted' : 'Uploading…') + '</small></div>' +
            '<select data-tag="' + i + '"' + (d.id ? '' : ' disabled') + '>' + TAGS.map(function (t) { return '<option value="' + t[0] + '"' + (d.tag === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select>' +
            '<button type="button" class="mini" data-rm="' + i + '">Remove</button></div>'; }).join('') + '</div>' : '') +
        '<p class="mut" style="margin:8px 0 0;font-size:12px">Documents are stored encrypted and attached to the patient when you create them. You can switch to manual entry at any time.</p>';
    };
    var add = function (files) {
      [].slice.call(files || []).forEach(function (f) {
        var d = { name: f.name || 'Photo', ct: f.type, tag: guessTag(f.name), preview: /^image\/(jpeg|png|webp|gif)/.test(f.type) ? URL.createObjectURL(f) : '' };
        st.docs.push(d); draw();
        // one at a time, so every file joins the intake the first upload starts
        st.q = (st.q || Promise.resolve()).then(function () {
          var fd = new FormData(); fd.append('file', f); fd.append('tag', d.tag); fd.append('intake_id', st.intakeId);
          return api('POST', '/api/intake/documents', null, fd).then(function (j) { d.id = j.id; d.ct = j.contentType; st.intakeId = j.intakeId; draw();
            if (d.tag !== j.tag) api('PATCH', '/api/intake/documents/' + d.id, { tag: d.tag }).catch(function () {}); },   // retagged while it waited
            function (e) { d.error = e.message; draw(); });
        });
      });
    };
    draw();
    body.addEventListener('change', function (e) {
      if (e.target.id === 'pi-files' || e.target.id === 'pi-cam') { add(e.target.files); e.target.value = ''; }
      if (e.target.dataset.tag != null) { var d = st.docs[+e.target.dataset.tag]; d.tag = e.target.value; if (d.id) api('PATCH', '/api/intake/documents/' + d.id, { tag: d.tag }).catch(function () {}); }
    });
    body.addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; var d = st.docs.splice(+b.dataset.rm, 1)[0]; if (d && d.id) api('DELETE', '/api/intake/documents/' + d.id).catch(function () {}); draw(); });
    body.addEventListener('dragover', function (e) { e.preventDefault(); var z = body.querySelector('#pi-drop'); if (z) z.classList.add('on'); });
    body.addEventListener('dragleave', function () { var z = body.querySelector('#pi-drop'); if (z) z.classList.remove('on'); });
    body.addEventListener('drop', function (e) { e.preventDefault(); add(e.dataTransfer.files); });
  }

  // ---------- 3. read ----------
  function read(st, after, w) {
    var btn = w.querySelector('[data-mb="2"]'); btn.disabled = true; btn.textContent = 'Reading ' + st.docs.filter(function (d) { return d.id; }).length + ' document(s)…';
    api('POST', '/api/intake/' + st.intakeId + '/extract').then(function (r) {
      w.remove();
      st.result = r;
      if (r.status === 'unavailable' || r.status === 'failed') { U.toast(r.message, 'warn'); return toManual(st, after); }   // fall back with whatever was read
      if (r.message) U.toast(r.message, 'warn');
      review(st, after);
    }, function (e) { w.remove(); U.toast('The documents couldn’t be read (' + e.message + '). Fill in the form from them.', 'warn'); toManual(st, after); });
  }

  // ---------- 4. review ----------
  function review(st, after) {
    var r = st.result || { fields: {}, conflicts: {}, documents: [] }, prov = {}, vals = {};
    Object.keys(r.fields).forEach(function (k) { vals[k] = r.fields[k].value; prov[k] = 'ai'; });
    Object.keys(st.values || {}).forEach(function (k) { if (st.values[k] != null && st.values[k] !== '') { vals[k] = st.values[k]; if (!prov[k]) prov[k] = 'manual'; } });
    var docs = r.documents || [], cur = docs[0] ? docs[0].id : null, urls = {};
    var show = function (k) { return Array.isArray(vals[k]) ? vals[k].join('\n') : (vals[k] == null ? '' : String(vals[k])); };
    var fieldHtml = function (f) {
      var k = f[0], info = r.fields[k], conf = r.conflicts[k], cls = conf && !prov[k] ? 'pi-conflict' : info && info.confidence === 'low' && prov[k] === 'ai' ? 'pi-low' : '';
      var input = f[3] === 'sex' ? '<select data-f="' + k + '"><option value=""></option>' + ['F', 'M', 'X'].map(function (x) { return '<option' + (show(k) === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>'
        : f[3] === 'list' ? '<textarea data-f="' + k + '" rows="2" placeholder="One per line">' + E(show(k)) + '</textarea>'
        : '<input data-f="' + k + '" type="' + (f[3] === 'date' ? 'date' : 'text') + '" value="' + E(show(k)) + '"' + (k === 'address_state' ? ' maxlength="2"' : '') + '>';
      return '<div class="pi-f ' + cls + (f[4] ? ' s' + f[4] : '') + '" data-wrap="' + k + '"><label>' + E(f[1]) + (f[2] ? ' <span class="s-red">*</span>' : '') +
        (info && prov[k] === 'ai' ? ' <span class="pi-src" data-src="' + k + '" title="Show where this came from">' + E(info.confidence) + ' · ' + E((TAGS.filter(function (t) { return t[0] === info.tag; })[0] || [0, ''])[1]) + '</span>' : '') + '</label>' + input +
        (conf && !prov[k] ? '<div class="pi-opts"><span>Documents disagree. Pick one or type it:</span>' + conf.map(function (c, i) { return '<button type="button" class="mini" data-pick="' + k + '|' + i + '">' + E(String(c.value)) + ' <small>' + E((TAGS.filter(function (t) { return t[0] === c.tag; })[0] || [0, ''])[1]) + '</small></button>'; }).join('') + '</div>' : '') +
        '<div class="pi-err" data-err="' + k + '"></div></div>';
    };
    var counts = { low: Object.keys(r.fields).filter(function (k) { return r.fields[k].confidence === 'low'; }).length, conf: Object.keys(r.conflicts).length };
    var html = '<div class="pi-review"><div class="pi-form">' +
      '<div class="pi-legend"><span><i class="pi-sw low"></i>Low confidence: check it</span><span><i class="pi-sw conflict"></i>Documents disagree: choose</span><span>' + Object.keys(r.fields).length + ' fields read · ' + counts.low + ' to check · ' + counts.conf + ' to choose</span></div>' +
      SECTIONS.map(function (s) { return '<div class="pi-sec"><h4>' + E(s[0]) + '</h4><div class="pi-grid">' + s[1].map(fieldHtml).join('') + '</div></div>'; }).join('') + '</div>' +
      '<div class="pi-doc"><div class="pi-tabs">' + docs.map(function (d) { return '<button type="button" data-doc="' + d.id + '" class="' + (d.id === cur ? 'on' : '') + '">' + E(d.tagLabel) + (d.status === 'failed' ? ' ' + U.warn : '') + '</button>'; }).join('') + '</div><div class="pi-view" id="pi-view"></div></div></div>';
    var w = U.modal('Review New Patient', html, [['Cancel', '', function () {}], ['Switch To Manual Form', '', function () { collect(); st.values = vals; toManual(st, after, prov); }],
      ['Confirm & Create Patient', 'pri', function () { collect(); var errs = validate(vals); paintErrors(errs); if (Object.keys(errs).length) { U.toast('Fix the highlighted fields first.', 'warn'); return false; } create(st, vals, prov, after); }]], { wide: 1, width: 1240 });
    var view = w.querySelector('#pi-view');
    var openDoc = function (id, box) {
      cur = id; w.querySelectorAll('[data-doc]').forEach(function (b) { b.classList.toggle('on', +b.dataset.doc === id); });
      var d = docs.filter(function (x) { return x.id === id; })[0]; if (!d) { view.innerHTML = '<div class="mut" style="padding:20px">No document.</div>'; return; }
      var paint = function (url) {
        view.innerHTML = d.contentType === 'application/pdf' ? '<iframe src="' + url + '" title="' + E(d.tagLabel) + '"></iframe>'
          : '<div class="pi-img"><img src="' + url + '" alt="' + E(d.tagLabel) + '">' + (box ? '<i class="pi-box" style="left:' + box[0] * 100 + '%;top:' + box[1] * 100 + '%;width:' + (box[2] - box[0]) * 100 + '%;height:' + (box[3] - box[1]) * 100 + '%"></i>' : '') + '</div>';
      };
      if (urls[id]) return paint(urls[id]);
      view.innerHTML = '<div class="mut" style="padding:20px">Loading…</div>';
      fetch('/api/intake/documents/' + id + '/file', { credentials: 'same-origin' }).then(function (x) { return x.blob(); }).then(function (b) { urls[id] = URL.createObjectURL(b); paint(urls[id]); });
    };
    var collect = function () { w.querySelectorAll('[data-f]').forEach(function (el) { var k = el.dataset.f, v = el.value.trim(); vals[k] = LISTS[k] ? (v ? v.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean) : null) : (v || null); }); };
    var paintErrors = function (errs) { w.querySelectorAll('[data-err]').forEach(function (el) { var m = errs[el.dataset.err] || ''; el.textContent = m; el.parentNode.classList.toggle('pi-bad', !!m); }); };
    if (cur) openDoc(cur, null);
    w.addEventListener('click', function (e) {
      var t = e.target.closest('[data-doc]'); if (t) return openDoc(+t.dataset.doc, null);
      var s = e.target.closest('[data-src]'); if (s) { var f = r.fields[s.dataset.src]; if (f) openDoc(f.docId, f.box); return; }
      var p = e.target.closest('[data-pick]'); if (p) { var kk = p.dataset.pick.split('|'), c = r.conflicts[kk[0]][+kk[1]], el = w.querySelector('[data-f="' + kk[0] + '"]');
        el.value = Array.isArray(c.value) ? c.value.join('\n') : c.value; prov[kk[0]] = 'ai'; var wr = w.querySelector('[data-wrap="' + kk[0] + '"]'); wr.classList.remove('pi-conflict'); var o = wr.querySelector('.pi-opts'); if (o) o.remove(); openDoc(c.docId, c.box); }
    });
    w.addEventListener('focusin', function (e) { var k = e.target.dataset && e.target.dataset.f, f = k && r.fields[k]; if (f && prov[k] === 'ai' && f.docId !== cur) openDoc(f.docId, f.box); else if (f && prov[k] === 'ai') openDoc(f.docId, f.box); });
    w.addEventListener('input', function (e) {
      var k = e.target.dataset && e.target.dataset.f; if (!k) return;
      var v = e.target.value.trim(), was = r.fields[k] ? show(k) : null;
      prov[k] = r.fields[k] ? (v === '' ? 'ai_cleared' : v === String(was).trim() ? 'ai' : 'ai_edited') : (v ? 'manual' : undefined);
      if (!prov[k]) delete prov[k];
      var wr = e.target.closest('.pi-f'); wr.classList.remove('pi-low'); if (prov[k] !== undefined && r.conflicts[k]) { wr.classList.remove('pi-conflict'); var o = wr.querySelector('.pi-opts'); if (o) o.remove(); }
    });
    w.addEventListener('focusout', function (e) { if (!e.target.dataset || !e.target.dataset.f) return; collect(); var errs = validate(vals), k = e.target.dataset.f, m = {}; m[k] = errs[k]; var el = w.querySelector('[data-err="' + k + '"]'); el.textContent = errs[k] || ''; el.parentNode.classList.toggle('pi-bad', !!errs[k]); });
  }

  // the same checks the server runs (patient_intake.validate_patient)
  function validate(v) {
    var err = {}, today = D.today(), digits = function (x) { var d = String(x || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
    [['first_name', 'First name'], ['last_name', 'Last name'], ['date_of_birth', 'Date of birth']].forEach(function (r) { if (!String(v[r[0]] || '').trim()) err[r[0]] = r[1] + ' is required.'; });
    ['date_of_birth', 'subscriber_date_of_birth'].forEach(function (k) { var x = String(v[k] || ''); if (!x || err[k]) return; if (!/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(new Date(x + 'T12:00:00'))) err[k] = 'Use a real date (MM/DD/YYYY).'; else if (x > today) err[k] = 'Can’t be in the future.'; else if (x < '1900') err[k] = 'Check the year.'; });
    if (v.address_zip && !/^\d{5}(-?\d{4})?$/.test(String(v.address_zip).trim())) err.address_zip = 'ZIP must be 5 or 9 digits.';
    ['phone', 'emergency_contact_phone', 'payer_phone'].forEach(function (k) { if (v[k] && digits(v[k]).length !== 10) err[k] = 'Phone must be 10 digits.'; });
    if (v.address_state && STATES.indexOf(String(v.address_state).trim().toUpperCase()) < 0) err.address_state = 'Use a 2-letter US state code.';
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) err.email = 'Check the email address.';
    return err;
  }

  // review values -> the EMR's patient record
  function toPatient(v) {
    var ph = function (x) { var d = String(x || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (x || ''); };
    var cap = function (s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); };
    var payer = String(v.payer_name || ''), known = D.PAYERS.filter(function (x) { return x.toLowerCase() === payer.toLowerCase() || payer.toLowerCase().indexOf(x.toLowerCase().split(' ')[0]) === 0; })[0];
    if (/united ?health|uhc/i.test(payer)) known = 'UHC';
    var list = function (x) { return Array.isArray(x) ? x : x ? [x] : []; };
    return { name: cap(v.last_name) + ', ' + cap(v.first_name) + (v.middle_name ? ' ' + cap(v.middle_name) : ''), dob: v.date_of_birth || '', sex: v.sex || 'X', phone: ph(v.phone), email: v.email || '',
      addr: [v.address_street, v.address_city, [String(v.address_state || '').toUpperCase(), v.address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      payer: known || payer, member: v.member_id || '', pcp: (V.myProvider() || {}).id || '', balance: 0,
      allergies: list(v.allergies).join('; '), problems: list(v.medical_history).join('; '), meds: list(v.medications).join('\n'),
      insurance: { group: v.group_number || '', plan: v.plan_name || '', subscriber: v.subscriber_name || '', subscriberDob: v.subscriber_date_of_birth || '', relationship: v.relationship_to_patient || '',
        payerPhone: ph(v.payer_phone), rxBin: v.rx_bin || '', rxPcn: v.rx_pcn || '', payerAsPrinted: payer },
      emergency: { name: v.emergency_contact_name || '', phone: ph(v.emergency_contact_phone) }, pharmacy: v.preferred_pharmacy || '', referring: v.referring_provider || '' };
  }

  // ---------- 5. create ----------
  function create(st, vals, prov, after) {
    var p = toPatient(vals); p.mrn = D.nextMrn(p.name); p.created = D.today(); p.status = 'New'; p.intakeId = st.intakeId;
    S.patients.push(p); D.log('Patient added from scanned documents: ' + p.name); D.save();
    var sub = String(vals.subscriber_name || '').trim(), parts = sub.indexOf(',') > 0 ? sub.split(/\s*,\s*/) : sub.split(/\s+/).reverse();
    var self = !sub || /^self$/i.test(vals.relationship_to_patient || '') || sub.replace(/\W/g, '').toLowerCase() === (String(vals.first_name) + String(vals.last_name)).replace(/\W/g, '').toLowerCase() || sub.replace(/\W/g, '').toLowerCase() === (String(vals.last_name) + String(vals.first_name)).replace(/\W/g, '').toLowerCase();
    var rel = self ? 'self' : (/spouse|wife|husband/i.test(vals.relationship_to_patient || '') ? 'spouse' : /child|son|daughter|dependent/i.test(vals.relationship_to_patient || '') ? 'child' : 'other');
    var ins = vals.payer_name && vals.member_id ? { payer: p.payer, member_id: vals.member_id, patient_dob: vals.date_of_birth, relationship: rel,
      subscriber_first: self ? vals.first_name : (parts[1] || ''), subscriber_last: self ? vals.last_name : (parts[0] || ''), subscriber_dob: self ? vals.date_of_birth : (vals.subscriber_date_of_birth || '') } : null;
    U.toast(p.name + ' added, MRN ' + p.mrn + '.');
    if (st.intakeId) api('POST', '/api/intake/' + st.intakeId + '/confirm', { mrn: p.mrn, provenance: prov, insurance: ins }).then(function (j) {
      var e = j.eligibility; if (!e) return;
      p.eligibility = e; if (e.status === 'active' || e.status === 'inactive') p.eligChecked = D.today(); D.save();
      U.toast(e.status === 'active' ? 'Coverage active' + (e.copay != null ? ' · copay $' + e.copay : '') + (e.deductible != null ? ' · deductible $' + e.deductible : '') : e.status === 'inactive' ? 'Coverage is inactive with ' + p.payer + '.' : (e.errors || [])[0] || 'Eligibility wasn’t checked.', e.status === 'active' ? 'ok' : e.status === 'inactive' ? 'warn' : 'info');
    }).catch(function (e2) { U.toast('Patient saved, but the documents weren’t attached: ' + e2.message, 'warn'); });
    if (after) after(p); else V.refresh();
  }

  // manual entry with everything already filled in; uploaded documents are still attached when they save
  function toManual(st, after, prov) {
    var v = Object.assign({}, st.values || {});
    var r = st.result; if (r) Object.keys(r.fields || {}).forEach(function (k) { if (v[k] == null) v[k] = r.fields[k].value; });
    var pre = toPatient(Object.assign({ first_name: '', last_name: '' }, v)); var preset = {};
    ['dob', 'sex', 'phone', 'email', 'addr', 'payer', 'member', 'allergies', 'problems', 'meds'].forEach(function (k) { if (pre[k]) preset[k] = pre[k]; });
    if (v.last_name || v.first_name) preset.name = pre.name;
    manualForm(null, function (p) {
      if (st.intakeId && st.docs && st.docs.some(function (d) { return d.id; })) {
        var pv = {}; Object.keys(prov || {}).forEach(function (k) { pv[k] = prov[k]; });
        api('POST', '/api/intake/' + st.intakeId + '/confirm', { mrn: p.mrn, provenance: pv }).catch(function () {});
      }
      if (after) after(p); else V.refresh();
    }, Object.keys(preset).length ? preset : undefined);
  }

  // scanned documents on the patient chart
  V.patientScans = function (mrn, el) {
    if (!el) return;
    api('GET', '/api/patients/' + encodeURIComponent(mrn) + '/scans').then(function (j) {
      el.innerHTML = (j.documents || []).length ? j.documents.map(function (d) { return '<div><a href="/api/intake/documents/' + d.id + '/file" target="_blank" rel="noopener">' + E(d.tagLabel) + '</a> <span class="mut">' + D.us((d.uploaded || '').slice(0, 10)) + '</span></div>'; }).join('') : '<span class="mut">No scanned documents.</span>';
    }, function () { el.innerHTML = ''; });
  };
})();
