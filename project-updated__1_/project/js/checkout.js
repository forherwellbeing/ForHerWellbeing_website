/* ForHerWellbeing checkout: any element with data-buy="<plan-id>" opens this.
   Plan names/prices come from the server (/api/plans); the server also decides
   what is charged, so nothing here can change the amount. */
(function () {
  var WHATSAPP = 'https://wa.me/918008383699';
  var plansCache = null;
  var busy = false;
  var current = null;
  var verifyToken = null;
  var cooldownTimer = null;

  var css =
    '.btn-outline{background:transparent;color:var(--plum,#3B1530);box-shadow:inset 0 0 0 1.5px var(--plum,#3B1530);border:0;font-family:inherit;cursor:pointer;}' +
    '.btn-outline:hover{background:var(--plum,#3B1530);color:#fff;}' +
    'button.btn{border:0;font-family:inherit;cursor:pointer;}' +
    '.btn-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;}' +
    '.btn-row .btn{line-height:1.5;}' +
    '.co-overlay{position:fixed;inset:0;z-index:200;background:rgba(38,16,31,.62);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;}' +
    '.co-overlay[hidden]{display:none;}' +
    '.co-modal{position:relative;background:#fff;width:100%;max-width:460px;border-radius:4px;padding:34px 32px 28px;box-shadow:0 24px 60px rgba(0,0,0,.35);font-family:var(--sans,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif);color:var(--ink,#2A2621);}' +
    '.co-close{position:absolute;top:10px;right:14px;background:none;border:0;font-size:1.7rem;line-height:1;color:var(--ink-soft,#6B655C);cursor:pointer;}' +
    '.co-kicker{font-size:.8rem;color:var(--plum-mid,#6C3159);margin:0 0 8px;}' +
    '.co-modal h2{font-family:var(--serif,Georgia,serif);color:var(--plum,#3B1530);font-weight:400;font-size:1.7rem;margin:0 0 6px;}' +
    '.co-summary{color:var(--ink-soft,#6B655C);font-size:.95rem;margin:0 0 14px;}' +
    '.co-price{font-family:var(--serif,Georgia,serif);color:var(--plum,#3B1530);font-size:1.6rem;margin-bottom:6px;}' +
    '.co-note{font-size:.85rem;color:var(--ink-soft,#6B655C);margin:0 0 18px;}' +
    '.co-field{margin-bottom:14px;}' +
    '.co-field label{display:block;font-size:.85rem;margin-bottom:5px;color:var(--ink,#2A2621);}' +
    '.co-field input{width:100%;padding:11px 12px;border:1px solid var(--line,#DED0C0);border-radius:2px;font:inherit;font-size:.95rem;}' +
    '.co-field input:focus{outline:2px solid var(--plum-mid,#6C3159);outline-offset:1px;}' +
    '.co-pay{width:100%;text-align:center;margin-top:6px;}' +
    '.co-pay:disabled{opacity:.6;cursor:not-allowed;}' +
    '.co-fine{font-size:.78rem;color:var(--ink-soft,#6B655C);text-align:center;margin:12px 0 0;}' +
    '.co-error{display:none;margin-top:14px;padding:10px 12px;border:1px solid #c0392b;color:#c0392b;font-size:.88rem;border-radius:2px;}' +
    '.co-error.show{display:block;}' +
    '.co-error a{color:inherit;font-weight:600;}' +
    '.co-done{text-align:center;padding:10px 0 4px;}' +
    '.co-tick{width:54px;height:54px;border-radius:50%;background:#2E6B3E;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;}' +
    '.co-done p{color:var(--ink-soft,#6B655C);font-size:.95rem;margin:0 0 10px;}' +
    '.co-pid{font-size:.8rem;word-break:break-all;}' +
    '.co-vrow{display:flex;gap:8px;}' +
    '.co-vrow input{flex:1;min-width:0;}' +
    '.co-vbtn{padding:0 14px;border:1px solid var(--plum,#3B1530);background:#fff;color:var(--plum,#3B1530);border-radius:2px;font:inherit;font-size:.85rem;cursor:pointer;white-space:nowrap;}' +
    '.co-vbtn:disabled{opacity:.6;cursor:not-allowed;}' +
    '.co-vbox{margin-top:10px;}' +
    '.co-vbox[hidden]{display:none;}' +
    '.co-vstatus{font-size:.82rem;margin-top:6px;min-height:1em;color:var(--ink-soft,#6B655C);}' +
    '.co-vstatus.ok{color:#2E6B3E;}' +
    '.co-vstatus.err{color:#c0392b;}';

  var html =
    '<div class="co-modal" role="dialog" aria-modal="true" aria-labelledby="coTitle">' +
      '<button type="button" class="co-close" aria-label="Close">&times;</button>' +
      '<form id="coForm" novalidate>' +
        '<p class="co-kicker">Secure checkout</p>' +
        '<h2 id="coTitle"></h2>' +
        '<p class="co-summary"></p>' +
        '<div class="co-price"></div>' +
        '<p class="co-note"></p>' +
        '<div class="co-field"><label for="coName">Full name</label><input id="coName" name="name" autocomplete="name" required></div>' +
        '<div class="co-field"><label for="coEmail">Email address</label>' +
          '<div class="co-vrow"><input id="coEmail" name="email" type="email" autocomplete="email" required><button type="button" class="co-vbtn" id="coSendCode">Verify email</button></div>' +
          '<div class="co-vbox" id="coVBox" hidden><label for="coCode">Enter the 6-digit code we emailed you</label>' +
            '<div class="co-vrow"><input id="coCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456"><button type="button" class="co-vbtn" id="coCheckCode">Confirm</button></div></div>' +
          '<p class="co-vstatus" id="coVStatus" aria-live="polite"></p></div>' +
        '<div class="co-field"><label for="coPhone">Phone / WhatsApp number</label><input id="coPhone" name="phone" type="tel" autocomplete="tel" required></div>' +
        '<button type="submit" class="btn btn-primary co-pay"></button>' +
        '<p class="co-fine">Secure payment by Razorpay: UPI, cards, netbanking and wallets.</p>' +
        '<div class="co-error" id="coError" role="alert"></div>' +
      '</form>' +
      '<div class="co-done" id="coDone" hidden>' +
        '<div class="co-tick"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"><path d="M4 12l5 5L20 6"/></svg></div>' +
        '<h2>Payment received</h2>' +
        '<p id="coDoneMsg"></p>' +
        '<p>Dr. Raga&rsquo;s team will contact you within 24 hours. A receipt is on its way to your email.</p>' +
        '<p class="co-pid" id="coPid"></p>' +
        '<a class="btn btn-primary" style="margin-top:8px;" href="' + WHATSAPP + '" target="_blank" rel="noopener">Message us on WhatsApp</a>' +
      '</div>' +
    '</div>';

  var overlay, form, errEl, payBtn;

  function inr(rupees) { return '\u20B9' + Number(rupees).toLocaleString('en-IN'); }

  function showError(msg, withWhatsApp) {
    errEl.textContent = msg;
    if (withWhatsApp) {
      errEl.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = WHATSAPP; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Message us on WhatsApp';
      errEl.appendChild(a);
    }
    errEl.classList.add('show');
  }
  function clearError() { errEl.classList.remove('show'); errEl.textContent = ''; }

  function setBusy(on, label) {
    busy = on;
    payBtn.disabled = on || !verifyToken || !(current && plansCache && plansCache.enabled);
    payBtn.textContent = on ? label : (current ? 'Pay ' + inr(current.amount) + ' securely' : 'Pay');
  }

  // ---- email verification (same one-time-code flow as the contact form) ----
  function vEl(id) { return document.getElementById(id); }
  function vStatus(msg, kind) {
    var el = vEl('coVStatus');
    el.textContent = msg || '';
    el.className = 'co-vstatus' + (kind ? ' ' + kind : '');
  }
  function postJSON(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok && b.ok, body: b }; }); });
  }
  function startCooldown(seconds) {
    clearTimeout(cooldownTimer);
    var left = seconds, btn = vEl('coSendCode');
    btn.disabled = true;
    (function tick() {
      if (left <= 0) { btn.disabled = false; btn.textContent = 'Resend code'; return; }
      btn.textContent = 'Resend in ' + left + 's';
      left -= 1;
      cooldownTimer = setTimeout(tick, 1000);
    })();
  }
  function resetVerify() {
    clearTimeout(cooldownTimer);
    verifyToken = null;
    vEl('coVBox').hidden = true;
    vEl('coCode').value = '';
    vEl('coSendCode').disabled = false;
    vEl('coSendCode').textContent = 'Verify email';
    vStatus('');
    if (current) setBusy(false);
  }
  function sendCode() {
    var input = vEl('coEmail'), email = input.value.trim(), btn = vEl('coSendCode');
    if (!email || !input.checkValidity()) { vStatus('Please enter a valid email address first.', 'err'); return; }
    vStatus('Sending code...');
    btn.disabled = true;
    postJSON('/api/verify-email/send', { email: email }).then(function (r) {
      if (r.ok) {
        vEl('coVBox').hidden = false;
        vEl('coCode').focus();
        vStatus('We sent a 6-digit code to ' + email + '. It expires in ' + r.body.expiresInMinutes + ' minutes.');
        startCooldown(r.body.resendAfterSeconds || 60);
      } else {
        vStatus((r.body && r.body.error) || 'Could not send the code. Please try again.', 'err');
        btn.disabled = false;
      }
    }).catch(function () {
      vStatus('Could not reach the server. Please check your connection and try again.', 'err');
      btn.disabled = false;
    });
  }
  function checkCode() {
    var code = vEl('coCode').value.trim(), btn = vEl('coCheckCode');
    if (!/^\d{6}$/.test(code)) { vStatus('Please enter the 6-digit code.', 'err'); return; }
    btn.disabled = true;
    postJSON('/api/verify-email/check', { email: vEl('coEmail').value.trim(), code: code }).then(function (r) {
      if (r.ok) {
        verifyToken = r.body.token;
        vEl('coVBox').hidden = true;
        clearTimeout(cooldownTimer);
        vEl('coSendCode').disabled = true;
        vEl('coSendCode').textContent = 'Verified \u2713';
        vStatus('Email verified. You can now pay.', 'ok');
        setBusy(false);
      } else {
        vStatus((r.body && r.body.error) || 'Could not verify the code.', 'err');
      }
    }).catch(function () {
      vStatus('Could not reach the server. Please try again.', 'err');
    }).then(function () { btn.disabled = false; });
  }

  function loadPlans() {
    if (plansCache) return Promise.resolve(plansCache);
    return fetch('/api/plans').then(function (r) { return r.json(); }).then(function (d) {
      plansCache = d; return d;
    });
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the payment window. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }

  function close() {
    if (busy) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  function open(planId) {
    ensureDom();
    clearError();
    form.hidden = false;
    document.getElementById('coDone').hidden = true;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    current = null;
    payBtn.disabled = true; payBtn.textContent = 'Loading...';

    loadPlans().then(function (d) {
      var plan = (d.plans || []).filter(function (p) { return p.id === planId; })[0];
      if (!plan) { showError('That plan is not available right now.', true); return; }
      current = plan;
      form.querySelector('#coTitle').textContent = plan.name;
      form.querySelector('.co-summary').textContent = plan.summary || '';
      form.querySelector('.co-price').textContent = inr(plan.amount);
      form.querySelector('.co-note').textContent = plan.note || '';
      setBusy(false);
      if (!d.enabled) showError('Online payment is not switched on yet.', true);
      else form.querySelector('#coName').focus();
    }).catch(function () {
      showError('Could not load plan details. Please try again.', true);
    });
  }

  function onPaid(resp) {
    setBusy(true, 'Confirming payment...');
    fetch('/api/orders/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: resp.razorpay_order_id,
        razorpay_payment_id: resp.razorpay_payment_id,
        razorpay_signature: resp.razorpay_signature
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'verify failed');
      busy = false;
      form.hidden = true;
      document.getElementById('coDone').hidden = false;
      document.getElementById('coDoneMsg').textContent = 'Thank you! We have received ' + inr(d.amount / 100) + ' for ' + d.planName + '.';
      document.getElementById('coPid').textContent = 'Payment ID: ' + d.paymentId;
      form.reset();
      resetVerify();
    }).catch(function () {
      setBusy(false);
      payBtn.disabled = true;
      showError('Your payment went through, but we could not confirm it on screen. Please do not pay again. Send us this payment ID: ' + resp.razorpay_payment_id + '.', true);
    });
  }

  function onSubmit(e) {
    e.preventDefault();
    if (busy || !current) return;
    clearError();
    if (!form.reportValidity()) return;
    if (!verifyToken) { showError('Please verify your email address before paying.'); return; }
    var f = form.elements;
    var customer = { name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim() };

    setBusy(true, 'Starting payment...');
    fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: current.id, name: customer.name, email: customer.email, phone: customer.phone, verificationToken: verifyToken })
    }).then(function (r) { return r.json(); }).then(function (order) {
      if (!order.ok) {
        if (/verify your email/i.test(order.error || '')) resetVerify();
        throw new Error(order.error || 'Could not start the payment.');
      }
      return loadRazorpay().then(function () {
        var rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'ForHerWellbeing',
          description: order.planName,
          prefill: { name: customer.name, email: customer.email, contact: customer.phone },
          theme: { color: '#3B1530' },
          handler: onPaid,
          modal: { ondismiss: function () { if (busy) setBusy(false); } }
        });
        rzp.on('payment.failed', function (resp) {
          setBusy(false);
          showError((resp.error && resp.error.description) || 'The payment failed. You have not been charged; please try again.');
        });
        rzp.open();
      });
    }).catch(function (err) {
      setBusy(false);
      showError(err.message || 'Something went wrong. Please try again.');
    });
  }

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'co-overlay';
    overlay.hidden = true;
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    form = overlay.querySelector('#coForm');
    errEl = overlay.querySelector('#coError');
    payBtn = overlay.querySelector('.co-pay');
    form.addEventListener('submit', onSubmit);
    overlay.querySelector('#coSendCode').addEventListener('click', sendCode);
    overlay.querySelector('#coCheckCode').addEventListener('click', checkCode);
    // Changing the email after sending/verifying means starting over
    overlay.querySelector('#coEmail').addEventListener('input', function () {
      if (verifyToken || !vEl('coVBox').hidden || vEl('coSendCode').disabled) resetVerify();
    });
    overlay.querySelector('.co-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) close(); });
  }

  // styles for the buttons must exist before the modal is ever opened
  var early = document.createElement('style');
  early.textContent = css;
  document.head.appendChild(early);

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-buy]');
    if (!el) return;
    e.preventDefault();
    open(el.getAttribute('data-buy'));
  });

  // Deep link, e.g. programs.html?buy=yoga (handy for Instagram bio / WhatsApp messages)
  window.addEventListener('DOMContentLoaded', function () {
    var id = new URLSearchParams(location.search).get('buy');
    if (id) open(id);
  });

  window.ForHerCheckout = { open: open };
})();
