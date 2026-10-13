/* v4 working preview, part 6: Revenue › Claim Tracker. Every claim Althais has for the clinic, on one line from signing to
   payment: Signed, Queued (approved, waiting for Althais's end-of-day submission), Submitted, Accepted By Clearinghouse,
   Accepted By Payer, Paid. Server: /api/billing/claims (billing_activation.py), fed by Claim.MD's responses. A payment
   recorded in Claims (an ERA or a manual entry) shows here too. */
(function () {
  var app = V.app, E = U.esc, M = U.money;
  var T = null, ERR = '', Q = 'all', sel = V.q.get('claim') || '';
  var QUEUES = [['all', 'All Claims'], ['queued', 'Queued For Today'], ['submitted', 'Submitted'], ['clearinghouse', 'Accepted By Clearinghouse'],
    ['payer', 'Accepted By Payer'], ['paid', 'Paid'], ['problems', 'Needs Attention']];
  var when = function (iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : ''; };
  var dosOf = function (d) { return /^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? window.D.us(String(d).slice(0, 10)) : (d || '-'); };
  var day = function (iso) { return iso ? window.D.us(String(iso).slice(0, 10), 1) : '-'; };

  // a payment recorded in Claims counts here too
  function merged() {
    return (T ? T.claims : []).map(function (t) {
      var c = window.D.claim(t.claimId), x = Object.assign({}, t, { steps: t.steps.map(function (s) { return Object.assign({}, s); }) });
      if (c && c.stage === 'paid' && !x.steps[5].at) { x.steps[5].at = c.paidOn || window.D.today(); x.step = 5; x.state = 'Paid'; x.paid = c.paid; }
      if (c && c.stage === 'denied' && !x.rejected) { x.state = 'Denied'; x.denied = c.reason || c.carc || ''; }
      return x;
    });
  }
  var inQ = function (x, q) {
    return q === 'all' || (q === 'queued' && x.delivery === 'QUEUED') || (q === 'problems' && (x.rejected || x.delivery === 'HELD' || x.delivery === 'FAILED' || x.state === 'Denied')) ||
      (q === 'submitted' && x.delivery === 'SENT' && x.step === 2 && !x.rejected) || (q === 'clearinghouse' && x.step === 3 && !x.rejected) || (q === 'payer' && x.step === 4 && !x.rejected) || (q === 'paid' && x.step === 5);
  };
  function tone(x) { return x.rejected || x.state === 'Denied' ? 'red' : x.delivery === 'HELD' || x.delivery === 'FAILED' ? 'amb' : x.step === 5 ? 'grn' : 'blue'; }
  function bar(x) {
    return '<div class="ct-bar" title="' + E(x.state) + '">' + x.steps.map(function (s, i) {
      var cls = i < x.step || (i === x.step && !x.rejected && x.delivery !== 'HELD') ? 'on' : i === x.step ? tone(x) : '';
      if (i === x.step + 1 && (x.rejected || x.delivery === 'HELD')) cls = tone(x);
      return '<i class="' + cls + '"></i>';
    }).join('') + '</div>';
  }
  function statusCell(x) { var t = tone(x); return '<span class="tc s-' + (t === 'blue' ? 'blue' : t) + '">' + (t === 'grn' ? U.I.check : t === 'red' || t === 'amb' ? U.warn : '') + E(x.delivery === 'QUEUED' ? 'Queued' : x.state) + '</span>'; }

  function detail(x) {
    if (!x) return U.pane('Claim', '', '', '<div class="blank">Select a claim to see every step.</div>');
    var tl = x.steps.map(function (s, i) {
      var done = !!s.at, now = i === x.step + 1 && !x.rejected && x.delivery !== 'HELD' && x.step < 5, bad = (x.rejected || x.delivery === 'HELD' || x.state === 'Denied') && i === x.step + 1;
      var sub = done ? when(s.at) : now ? (s.key === 'submitted' ? 'Althais submits it at ' + V.batchTime(T.nextBatch) + ' with today’s batch' : 'Waiting on ' + (s.key === 'clearinghouse' ? 'the clearinghouse' : s.key === 'payer' ? 'the payer' : 'payment')) :
        bad ? (x.rejected ? 'Rejected' : x.state === 'Denied' ? 'Denied' : 'Held') : '';
      return '<div class="ct-step ' + (done ? 'done' : bad ? 'bad' : now ? 'now' : '') + '"><span class="ct-dot">' + (done ? U.I.check : bad ? '!' : i + 1) + '</span><div><b>' + E(s.label) + '</b><small>' + E(sub) + '</small></div></div>';
    }).join('');
    var probs = (x.blockers || []).map(function (b) { return '<div class="ct-prob"><b>' + E(b.title) + '</b>: ' + E(b.reason) + (b.next ? '<div class="mut">' + E(b.next) + '</div>' : '') + '</div>'; }).join('') +
      (x.denied ? '<div class="ct-prob"><b>Denied</b>: ' + E(x.denied) + '<div class="mut"><a href="/v4/revenue/denials">Open Denials</a> to appeal.</div></div>' : '');
    var ev = (x.events || []).slice().reverse().map(function (e) { return '<div class="ct-ev"><span class="mut">' + when(e.at) + '</span> ' + E(e.kind.replace(/_/g, ' ')) + (e.status ? ' · ' + E(e.status.toLowerCase()) : '') + (e.note ? '<div class="t2">' + E(e.note) + '</div>' : '') + '</div>'; }).join('');
    return U.pane('Claim ' + E(x.claimId), '', V.link('Open Claim', V.claimHref(x.claimId)),
      '<div class="dp-sec"><div style="font-size:14px;font-weight:600">' + E(x.patient) + '</div>' + U.kv([['Payer', E(x.payer || '-')], ['Provider', E(x.provider || '-')], ['Date of service', E(dosOf(x.dos))], ['Amount', x.amount != null ? M(x.amount) : '-'],
        ['Clearinghouse ref', x.reference ? '<span class="mono">' + E(x.reference) + '</span>' : '-'], ['Status', statusCell(x)]]) + '</div>' +
      (probs ? '<div class="dp-sec"><div class="dp-h">Needs attention</div>' + probs + '</div>' : '') +
      '<div class="dp-sec"><div class="dp-h">Progress</div><div class="ct-tl">' + tl + '</div></div>' +
      (ev ? '<div class="dp-sec"><div class="dp-h">History</div>' + ev + '</div>' : ''));
  }

  function draw() {
    var all = merged(), list = all.filter(function (x) { return inQ(x, Q); });
    if (!sel || !all.some(function (x) { return x.claimId === sel; })) sel = list[0] ? list[0].claimId : '';
    var n = function (q) { return all.filter(function (x) { return inQ(x, q); }).length; }, amt = function (q) { return M(all.filter(function (x) { return inQ(x, q); }).reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0)); };
    var strip = U.strip([['Queued For Today', n('queued'), amt('queued') + ' · Althais submits ' + (T ? V.batchTime(T.nextBatch) : '')], ['Submitted', n('submitted'), amt('submitted')],
      ['Accepted By Payer', n('payer'), amt('payer')], ['Paid', n('paid'), amt('paid'), n('paid') ? 'grn' : ''], ['Needs Attention', n('problems'), amt('problems'), n('problems') ? 'amb' : '']]);
    var grid = !T ? '<div class="mut" style="padding:12px">' + (ERR ? '<span class="s-red">' + E(ERR) + '</span>' : 'Loading…') + '</div>' :
      U.grid(['Claim #', 'Patient', 'DOS', 'Payer', ['Amount', 'num'], 'Progress', 'Status', 'Updated'], list.map(function (x) {
        var last = x.steps.slice().reverse().filter(function (s) { return s.at; })[0];
        return { sel: x.claimId === sel, attrs: ' data-ct="' + E(x.claimId) + '"', cells: ['<a href="#">' + E(x.claimId) + '</a>', E(x.patient), E(dosOf(x.dos)), E(x.payer || '-'), x.amount != null ? M(x.amount) : '-', bar(x), statusCell(x), last ? day(last.at) : '-'] };
      }), { click: 1 }).replace('<tbody></tbody>', '<tbody>' + U.empty(8, T && T.claims.length ? 'None in this queue.' : 'No claims yet. When a provider signs a claim, it shows up here and Althais submits it with the end-of-day batch.') + '</tbody>');
    app.innerHTML = U.header('tracker') + U.toolbar('Claim Tracker', [['Refresh', 'refresh', { id: 'ctrefresh' }], '|', ['Claims', 'send', { href: '/v4/revenue/claims' }]], T ? 'Next Althais submission: ' + V.batchTime(T.nextBatch) : '') + strip +
      '<div class="main" style="grid-template-columns:210px minmax(0,1fr) 380px">' +
        U.pane('Stages', '', '', U.queue([{ h: 'Where Claims Are', items: QUEUES.map(function (q) { return { key: q[0], label: q[1], n: T ? n(q[0]) : '', color: q[0] === 'problems' ? 'amb' : q[0] === 'paid' ? 'grn' : q[0] === 'all' ? null : 'blue' }; }) }], Q)) +
        '<section class="pane"><div class="ph">' + E((QUEUES.filter(function (q) { return q[0] === Q; })[0] || QUEUES[0])[1]) + '</div><div class="pbody">' + grid + '</div></section>' +
        detail(list.filter(function (x) { return x.claimId === sel; })[0] || all.filter(function (x) { return x.claimId === sel; })[0]) +
      '</div>';
    U.fit(); U.search();
  }
  function load() {
    return fetch('/api/billing/claims', { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.detail || j.error || 'Could not load claims.'); return j; }); })
      .then(function (j) { T = j; ERR = ''; draw(); }, function (e) { ERR = e.message; draw(); });
  }

  V.pages.tracker = function () {
    V.redraw = draw; draw(); load();
    setInterval(function () { if (!document.hidden) load(); }, 60000);
    U.on(app, '[data-q]', 'click', function (el) { Q = el.dataset.q; sel = ''; draw(); });
    U.on(app, 'tr[data-ct]', 'click', function (tr, e) { e.preventDefault(); sel = tr.dataset.ct; draw(); });
    U.on(app, '#ctrefresh', 'click', function () { load().then(function () { U.toast('Up to date.'); }); });
  };
})();
