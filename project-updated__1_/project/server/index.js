require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zoho = require('./zoho');

const app = express();

// Render (and most hosts) put a proxy in front of the app. Without this, req.ip is the proxy's
// address for every visitor, so the per-IP rate limits below would apply to the whole site at once.
if (process.env.NODE_ENV === 'production' || process.env.RENDER) app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const ROOT_DIR = path.join(__dirname, '..');
// Set DATA_DIR to a persistent-disk path on Render (e.g. /var/data) so saved data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const INQUIRIES_FILE = path.join(DATA_DIR, 'inquiries.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Make sure the data folder/file exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(INQUIRIES_FILE)) fs.writeFileSync(INQUIRIES_FILE, '[]', 'utf-8');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf-8');

// rawBody is kept so Razorpay webhook signatures can be verified
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// The site is served straight from the project folder, so explicitly keep
// server code, saved customer data and config files from being downloadable.
const PRIVATE_PATHS = /^\/(data|server|node_modules)(\/|$)|^\/(package(-lock)?\.json|readme\.md|\.env.*|\.gitignore)$/i;
app.use((req, res, next) => {
  let p;
  try {
    p = decodeURIComponent(req.path);
  } catch (e) {
    return res.status(400).send('Bad request');
  }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (PRIVATE_PATHS.test(p)) return res.status(404).send('Not found');
  next();
});

// Serve the static site (index.html, about.html, etc.)
app.use(express.static(ROOT_DIR, { extensions: ['html'] }));

// --- Mail sending via Resend (HTTPS API — avoids SMTP ports being blocked) ---
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';

if (!RESEND_API_KEY) {
  console.warn(
    '[mailer] RESEND_API_KEY is missing from .env — inquiries will be saved but no email will be sent.'
  );
}

async function sendEmail({ to, subject, text, replyTo }) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not configured' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { sent: false, reason: `${res.status} ${errBody}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

async function sendNotificationEmail(inquiry) {
  const to = process.env.NOTIFY_EMAIL;
  if (!to) return { sent: false, reason: 'NOTIFY_EMAIL not configured' };

  const subject = `New inquiry from ${inquiry.name} (${inquiry.interest})`;
  const text = [
    `Name: ${inquiry.name}`,
    `Email: ${inquiry.email}`,
    `Phone: ${inquiry.phone}`,
    `Interested in: ${inquiry.interest}`,
    '',
    'Message:',
    inquiry.message || '(no message provided)',
    '',
    `Submitted: ${inquiry.submittedAt}`,
  ].join('\n');

  return sendEmail({ to, subject, text, replyTo: inquiry.email });
}

async function sendConfirmationEmail(inquiry) {
  const subject = `We received your inquiry — ForHerWellbeing`;
  const text = [
    `Hi ${inquiry.name},`,
    '',
    `Thank you for reaching out to ForHerWellbeing about "${inquiry.interest}". We've received your inquiry and typically respond within 24 hours.`,
    '',
    'Here is a copy of what you submitted:',
    `Phone: ${inquiry.phone}`,
    `Message: ${inquiry.message || '(no message provided)'}`,
    '',
    "If it's urgent, you can also reach us directly on WhatsApp: https://wa.me/918008383699",
    '',
    'Warm regards,',
    'ForHerWellbeing',
  ].join('\n');

  return sendEmail({ to: inquiry.email, subject, text });
}

// --- API ---------------------------------------------------------------

// Simple in-memory rate limiting per IP (basic abuse protection)
const submissionLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  submissionLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// --- Email verification (one-time code) ----------------------------------
// Flow: /api/verify-email/send emails a 6-digit code -> /api/verify-email/check
// swaps the correct code for a single-use token -> /api/contact requires that token.
// Everything is kept in memory: a server restart just means people ask for a new code.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000; // a code is valid for 10 minutes
const CODE_RESEND_MS = 60 * 1000; // wait 60s before asking for another code
const CODE_MAX_ATTEMPTS = 5; // wrong guesses allowed per code
const CODE_MAX_SENDS_PER_HOUR = 5; // codes per email address per hour
const TOKEN_TTL_MS = 30 * 60 * 1000; // verified status lasts 30 minutes
const isProd = process.env.NODE_ENV === 'production';

const pendingCodes = new Map(); // email -> { hash, expiresAt, attempts, lastSentAt }
const sendHistory = new Map(); // email -> [timestamps of codes sent]
const verifiedTokens = new Map(); // token -> { email, expiresAt }
const verifyIpLog = new Map(); // ip -> [timestamps]

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const hashCode = (code, email) =>
  crypto.createHash('sha256').update(`${code}:${email}`).digest('hex');

function windowLimited(log, key, windowMs, max) {
  const now = Date.now();
  const recent = (log.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  log.set(key, recent);
  return recent.length > max;
}

// Tidy up expired entries so memory doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCodes) if (v.expiresAt < now) pendingCodes.delete(k);
  for (const [k, v] of verifiedTokens) if (v.expiresAt < now) verifiedTokens.delete(k);
  for (const [k, v] of sendHistory) {
    const recent = v.filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length) sendHistory.set(k, recent);
    else sendHistory.delete(k);
  }
  for (const [k, v] of verifyIpLog) {
    const recent = v.filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length) verifyIpLog.set(k, recent);
    else verifyIpLog.delete(k);
  }
}, 5 * 60 * 1000).unref();

// A token works once, and only for the email address it was issued for
function consumeVerificationToken(email, token) {
  if (typeof token !== 'string' || !token) return false;
  const entry = verifiedTokens.get(token);
  if (!entry) return false;
  verifiedTokens.delete(token);
  return entry.expiresAt > Date.now() && entry.email === normalizeEmail(email);
}

// Checkout uses this one: it checks the token WITHOUT using it up, so a customer whose payment
// fails or who closes the Razorpay window can try again without re-verifying (still expires in 30 min).
function checkVerificationToken(email, token) {
  if (typeof token !== 'string' || !token) return false;
  const entry = verifiedTokens.get(token);
  return Boolean(entry) && entry.expiresAt > Date.now() && entry.email === normalizeEmail(email);
}

// Step 1: email a code to the address the visitor typed in
app.post('/api/verify-email/send', async (req, res) => {
  try {
    if (windowLimited(verifyIpLog, req.ip, 10 * 60 * 1000, 10)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again in a few minutes.' });
    }

    const email = normalizeEmail(req.body && req.body.email);
    if (!EMAIL_PATTERN.test(email) || email.length > 200) {
      return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
    }

    const now = Date.now();
    const existing = pendingCodes.get(email);
    if (existing && now - existing.lastSentAt < CODE_RESEND_MS) {
      const wait = Math.ceil((CODE_RESEND_MS - (now - existing.lastSentAt)) / 1000);
      return res.status(429).json({ ok: false, error: `Please wait ${wait}s before requesting another code.` });
    }
    const sends = (sendHistory.get(email) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (sends.length >= CODE_MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ ok: false, error: 'Too many codes requested for this email. Please try again later.' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const mail = await sendEmail({
      to: email,
      subject: `Your ForHerWellbeing verification code: ${code}`,
      text: [
        'Hi,',
        '',
        `Your verification code is: ${code}`,
        '',
        'It expires in 10 minutes. Enter it on the contact form to confirm this is your email address.',
        "If you didn't request this, you can safely ignore this email.",
        '',
        'ForHerWellbeing',
      ].join('\n'),
    });

    if (!mail.sent) {
      if (isProd) {
        console.error('[verify] Could not send verification code:', mail.reason);
        return res.status(502).json({
          ok: false,
          error: "We couldn't send the code right now. Please try again, or contact us on WhatsApp.",
        });
      }
      // Local development without working email: print the code in the terminal instead
      console.warn(`[verify] Email not sent (${mail.reason}). DEV ONLY - code for ${email}: ${code}`);
    }

    pendingCodes.set(email, { hash: hashCode(code, email), expiresAt: now + CODE_TTL_MS, attempts: 0, lastSentAt: now });
    sends.push(now);
    sendHistory.set(email, sends);
    return res.json({ ok: true, resendAfterSeconds: CODE_RESEND_MS / 1000, expiresInMinutes: CODE_TTL_MS / 60000 });
  } catch (err) {
    console.error('[verify] Send error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again later.' });
  }
});

// Step 2: visitor types the code; a correct one is swapped for a single-use token
app.post('/api/verify-email/check', (req, res) => {
  try {
    if (windowLimited(verifyIpLog, req.ip, 10 * 60 * 1000, 30)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again in a few minutes.' });
    }

    const email = normalizeEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    const entry = pendingCodes.get(email);

    if (!entry || entry.expiresAt < Date.now()) {
      pendingCodes.delete(email);
      return res.status(400).json({ ok: false, error: 'That code has expired. Please request a new one.' });
    }

    entry.attempts += 1;
    if (entry.attempts > CODE_MAX_ATTEMPTS) {
      pendingCodes.delete(email);
      return res.status(429).json({ ok: false, error: 'Too many wrong attempts. Please request a new code.' });
    }

    if (!/^\d{6}$/.test(code) || !safeEqual(hashCode(code, email), entry.hash)) {
      return res.status(400).json({ ok: false, error: "That code isn't right. Please check it and try again." });
    }

    pendingCodes.delete(email);
    const token = crypto.randomBytes(24).toString('hex');
    verifiedTokens.set(token, { email, expiresAt: Date.now() + TOKEN_TTL_MS });
    return res.json({ ok: true, token });
  } catch (err) {
    console.error('[verify] Check error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again later.' });
  }
});

app.post('/api/contact', async (req, res) => {
  try {
    const ip = req.ip;
    if (isRateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Too many submissions. Please try again in a minute.' });
    }

    const { name, email, phone, interest, message, website, verificationToken } = req.body;

    // Honeypot field: real users never fill this in; bots often do.
    if (website) {
      return res.json({ ok: true }); // pretend success, silently drop
    }

    if (!name || !email || !phone) {
      return res.status(400).json({ ok: false, error: 'Name, email and phone are required.' });
    }

    if (!EMAIL_PATTERN.test(String(email))) {
      return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
    }

    // The email must have been confirmed with a one-time code (see /api/verify-email/*)
    if (!consumeVerificationToken(email, verificationToken)) {
      return res.status(400).json({
        ok: false,
        error: 'Please verify your email address first (the verification may have expired).',
      });
    }

    const inquiry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      interest: interest ? String(interest).trim() : 'Not sure yet',
      message: message ? String(message).trim() : '',
      emailVerified: true,
      submittedAt: new Date().toISOString(),
    };

    // Persist to local JSON file
    const existing = JSON.parse(fs.readFileSync(INQUIRIES_FILE, 'utf-8'));
    existing.push(inquiry);
    fs.writeFileSync(INQUIRIES_FILE, JSON.stringify(existing, null, 2), 'utf-8');

    // Fire off email notifications (does not block success response on failure)
    const [ownerMail, userMail] = await Promise.all([
      sendNotificationEmail(inquiry),
      sendConfirmationEmail(inquiry),
    ]);
    if (!ownerMail.sent) {
      console.warn('[contact] Saved inquiry, but owner notification email was not sent:', ownerMail.reason);
    }
    if (!userMail.sent) {
      console.warn('[contact] Saved inquiry, but confirmation email to user was not sent:', userMail.reason);
    }

    // Push to Zoho CRM in the background (a Zoho outage never blocks the visitor)
    zoho.syncInquiry(inquiry).catch((e) => console.warn('[zoho] Inquiry sync failed:', e.message));

    return res.json({ ok: true });
  } catch (err) {
    console.error('[contact] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again later.' });
  }
});

// View saved inquiries (simple JSON list)
// Locked: needs the ADMIN_KEY env var, sent as an "x-admin-key" header. If ADMIN_KEY isn't set, it's disabled.
app.get('/api/inquiries', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  const supplied = req.get('x-admin-key');
  if (!adminKey || !supplied || !safeEqual(supplied, adminKey)) {
    return res.status(404).send('Not found');
  }
  const existing = JSON.parse(fs.readFileSync(INQUIRIES_FILE, 'utf-8'));
  res.json(existing);
});

// --- Payments (Razorpay) -------------------------------------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const RAZORPAY_API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
const paymentsEnabled = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

if (!paymentsEnabled) {
  console.warn(
    '[payments] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from .env — online payments are disabled.'
  );
}

// Prices live ONLY here (in rupees). The browser sends a plan id, never an amount,
// so nobody can change what they are charged by editing the page.
const PLANS = {
  'discovery-call': {
    name: 'Discovery Call',
    amount: 1000,
    summary: '45-minute 1:1 video call with Dr. Raga',
    note: 'This fee is credited against your program if you enrol.',
  },
  yoga: {
    name: 'Yoga (1 month)',
    amount: 2500,
    summary: 'Live morning group batches for one month',
    note: 'Monthly plan: we will reach out before your next month starts.',
  },
  'diet-coaching': {
    name: 'Diet Coaching',
    amount: 30000,
    summary: '1:1 personalised nutrition programme with Dr. Raga',
  },
  'gut-metabolism-reset': {
    name: 'Gut Metabolism Reset',
    amount: 75000,
    summary: 'Microbiome sequencing, full panels and a gut-first reset protocol',
    note: 'This is the starting price. Dr. Raga will confirm your final scope with you before you begin.',
  },
};

const formatINR = (paise) => '\u20B9' + (paise / 100).toLocaleString('en-IN');

const readOrders = () => JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
const writeOrders = (orders) =>
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');

const hmacHex = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function razorpayPost(endpoint, body) {
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`${RAZORPAY_API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Razorpay ${res.status}: ${(data.error && data.error.description) || 'request failed'}`);
  }
  return data;
}

// Marks an order paid exactly once (verify endpoint and webhook can both call this).
// The read-check-write below is synchronous, so two callers can't both "win".
async function markOrderPaid(orderId, paymentId, paidAmount) {
  const orders = readOrders();
  const order = orders.find((o) => o.id === orderId);
  if (!order) return null;
  if (paidAmount !== undefined && paidAmount !== order.amount) {
    console.warn(`[payments] Amount mismatch on ${orderId}: expected ${order.amount}, got ${paidAmount}`);
    return null;
  }
  if (order.status === 'paid') return { order, newlyPaid: false };

  order.status = 'paid';
  order.paymentId = paymentId;
  order.paidAt = new Date().toISOString();
  writeOrders(orders);

  const amountText = formatINR(order.amount);
  const [ownerMail, customerMail] = await Promise.all([
    process.env.NOTIFY_EMAIL
      ? sendEmail({
          to: process.env.NOTIFY_EMAIL,
          subject: `Payment received: ${order.planName} (${amountText}) from ${order.name}`,
          replyTo: order.email,
          text: [
            `Plan: ${order.planName}`,
            `Amount: ${amountText}`,
            `Razorpay payment ID: ${paymentId}`,
            '',
            `Name: ${order.name}`,
            `Email: ${order.email}`,
            `Phone: ${order.phone}`,
            `Paid at: ${order.paidAt}`,
          ].join('\n'),
        })
      : { sent: false, reason: 'NOTIFY_EMAIL not configured' },
    sendEmail({
      to: order.email,
      subject: 'Payment received — ForHerWellbeing',
      text: [
        `Hi ${order.name},`,
        '',
        `Thank you! We've received your payment of ${amountText} for "${order.planName}".`,
        `Payment ID: ${paymentId}`,
        '',
        'Dr. Raga\'s team will contact you within 24 hours to get you started and schedule your first session.',
        'If it\'s urgent, you can reach us on WhatsApp: https://wa.me/918008383699',
        '',
        'Warm regards,',
        'ForHerWellbeing',
      ].join('\n'),
    }),
  ]);
  if (!ownerMail.sent) console.warn('[payments] Owner payment email not sent:', ownerMail.reason);
  if (!customerMail.sent) console.warn('[payments] Customer receipt not sent:', customerMail.reason);

  zoho.syncPaidOrder(order, paymentId).catch((e) => console.warn('[zoho] Order sync failed:', e.message));

  return { order, newlyPaid: true };
}

// Simple per-IP limiter for order creation
const orderLog = new Map();
function orderRateLimited(ip) {
  const now = Date.now();
  const recent = (orderLog.get(ip) || []).filter((t) => now - t < 60 * 1000);
  recent.push(now);
  orderLog.set(ip, recent);
  return recent.length > 10;
}

// Plan list for the checkout modal (name/price shown = price charged)
app.get('/api/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([id, p]) => ({ id, ...p }));
  res.json({ ok: true, enabled: paymentsEnabled, plans });
});

// Step 1: create a Razorpay order for a plan
app.post('/api/orders', async (req, res) => {
  try {
    if (!paymentsEnabled) {
      return res.status(503).json({
        ok: false,
        error: 'Online payment is not available yet. Please book on WhatsApp instead.',
      });
    }
    if (orderRateLimited(req.ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again in a minute.' });
    }

    const { planId, name, email, phone, verificationToken } = req.body || {};
    const plan = typeof planId === 'string' && Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
    if (!plan) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
    if (!name || !email || !phone) {
      return res.status(400).json({ ok: false, error: 'Name, email and phone are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
    }
    // The email must have been confirmed with a one-time code (same flow as the contact form)
    if (!checkVerificationToken(email, verificationToken)) {
      return res.status(400).json({
        ok: false,
        error: 'Please verify your email address first (the verification may have expired).',
      });
    }

    const customer = {
      name: String(name).trim().slice(0, 120),
      email: String(email).trim().slice(0, 200),
      phone: String(phone).trim().slice(0, 30),
    };
    const amount = plan.amount * 100; // paise

    const rzp = await razorpayPost('/orders', {
      amount,
      currency: 'INR',
      receipt: 'fhw_' + Date.now().toString(36),
      notes: { plan: plan.name, name: customer.name, email: customer.email, phone: customer.phone },
    });

    const orders = readOrders();
    orders.push({
      id: rzp.id,
      planId,
      planName: plan.name,
      amount,
      currency: 'INR',
      ...customer,
      emailVerified: true,
      status: 'created',
      createdAt: new Date().toISOString(),
    });
    writeOrders(orders);

    return res.json({
      ok: true,
      orderId: rzp.id,
      amount,
      currency: 'INR',
      keyId: RAZORPAY_KEY_ID,
      planName: plan.name,
    });
  } catch (err) {
    console.error('[payments] Could not create order:', err.message);
    return res.status(502).json({ ok: false, error: 'Could not start the payment. Please try again.' });
  }
});

// Step 2: browser reports a successful payment; we check Razorpay's signature
app.post('/api/orders/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every((v) => typeof v === 'string' && v)) {
      return res.status(400).json({ ok: false, error: 'Missing payment details.' });
    }
    const expected = hmacHex(RAZORPAY_KEY_SECRET || '', `${razorpay_order_id}|${razorpay_payment_id}`);
    if (!paymentsEnabled || !safeEqual(razorpay_signature, expected)) {
      return res.status(400).json({ ok: false, error: 'Payment could not be verified.' });
    }
    const result = await markOrderPaid(razorpay_order_id, razorpay_payment_id);
    if (!result) return res.status(404).json({ ok: false, error: 'Order not found.' });

    return res.json({
      ok: true,
      planName: result.order.planName,
      amount: result.order.amount,
      paymentId: razorpay_payment_id,
    });
  } catch (err) {
    console.error('[payments] Verify error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong while confirming your payment.' });
  }
});

// Safety net: Razorpay calls this even if the customer closes the tab right after paying.
// Dashboard > Settings > Webhooks: URL https://YOURDOMAIN/api/razorpay/webhook,
// events payment.captured (or order.paid), secret = RAZORPAY_WEBHOOK_SECRET.
app.post('/api/razorpay/webhook', async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ ok: false });
    const signature = req.get('x-razorpay-signature');
    if (!signature || !req.rawBody || !safeEqual(signature, hmacHex(RAZORPAY_WEBHOOK_SECRET, req.rawBody))) {
      return res.status(400).json({ ok: false });
    }
    const event = req.body && req.body.event;
    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
      if (payment && payment.order_id) {
        await markOrderPaid(payment.order_id, payment.id, payment.amount);
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[payments] Webhook error:', err);
    return res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`ForHerWellbeing server running at http://localhost:${PORT}`);
});