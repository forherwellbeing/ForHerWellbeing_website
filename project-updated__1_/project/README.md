# ForHerWellbeing website

Static HTML/CSS/JS frontend with a small Node/Express backend that handles
the contact form: it validates submissions, saves them to `data/inquiries.json`,
and (optionally) emails you a notification.

## Setup (in VS Code's terminal)

```bash
npm install
cp .env.example .env
```

Then open `.env` and fill in your Resend and Razorpay keys (see comments in `.env.example`).
If you skip this step, the server still works locally — inquiries are saved, verification codes
are printed in the terminal, and payments are switched off.

## Run it

```bash
npm run dev
```

Then open:
```
http://localhost:3000
```

Press `Ctrl+C` in the terminal to stop the server.

## How the contact form works

- `contact.html` posts form data to `POST /api/contact` (see `server/index.js`).
- Submissions are validated (name/email/phone required, basic email format check),
  rate-limited (5 per minute per IP), and protected by a hidden honeypot field.
- **Email verification:** visitors must confirm their email before they can send an inquiry.
  They click "Verify email", we email a 6-digit code (`POST /api/verify-email/send`), they type it in
  (`POST /api/verify-email/check`), and the server hands back a single-use token that `POST /api/contact`
  requires. Codes expire after 10 minutes, allow 5 wrong guesses, and can be re-sent once a minute
  (max 5 per address per hour). Verified inquiries are saved with `"emailVerified": true`.
  - This needs `RESEND_API_KEY` to be working, and in Resend you must **verify your own domain** and set
    `RESEND_FROM` to an address on it. With the default `onboarding@resend.dev` sender, Resend only
    delivers to your own account email, so real visitors would never get their code.
  - Set `NODE_ENV=production` on your live server. In development (the default) if an email can't be sent,
    the code is printed in the server terminal so you can still test the form locally.
- Every valid submission is appended to `data/inquiries.json`.
- If `RESEND_API_KEY` and `NOTIFY_EMAIL` are set, a notification email is sent to you with the inquiry
  details and `replyTo` set to the submitter's email, and the visitor gets a confirmation email.
- Saved inquiries can be viewed at `GET /api/inquiries`, but only with the `ADMIN_KEY` from `.env` sent
  as an `x-admin-key` header, e.g. `curl -H "x-admin-key: YOUR_KEY" https://YOURDOMAIN/api/inquiries`.
  If `ADMIN_KEY` isn't set, that route is switched off (404).

## Buying a plan (Razorpay)

- "Buy now" buttons on `programs.html` (and "Pay & book" on `contact.html`) open a
  checkout window that collects name/email/phone, then opens Razorpay.
- Prices live in **one place**: the `PLANS` object in `server/index.js`. The browser only
  sends a plan id, so the amount can't be changed from the page. Change a price there
  (and in the page text) when your pricing changes.
- **Email verification is required before paying too.** The checkout window has the same "Verify email" + 6-digit
  code step as the contact form; `POST /api/orders` rejects requests without a valid verification token for
  that email. The token lasts 30 minutes and can be reused for payment retries, so a failed payment doesn't
  force the customer to verify again.
- Flow: `POST /api/orders` creates the Razorpay order -> customer pays -> `POST /api/orders/verify`
  checks Razorpay's signature and marks it paid -> you and the customer get an email.
- `POST /api/razorpay/webhook` is a safety net for customers who close the tab right after paying.
- Orders are saved in `data/orders.json` (gitignored).
- Test mode: put `rzp_test_...` keys in `.env` and pay with Razorpay's test cards/UPI.
- Link straight to a checkout from anywhere: `programs.html?buy=yoga` (ids: `discovery-call`,
  `yoga`, `diet-coaching`, `gut-metabolism-reset`).

## Social buttons

The floating LinkedIn / Instagram / WhatsApp buttons come from `js/social.js`. Edit the
three links at the top of that file.

## Files

- `index.html`, `about.html`, `programs.html`, `results.html`, `women-abroad.html` — site pages
- `contact.html` — contact page, now wired up to the real backend
- `server/index.js` — Express server: serves the static site + the `/api/contact` and `/api/inquiries` routes
- `data/inquiries.json` — local storage for submitted inquiries (gitignored)
- `js/social.js` — floating social buttons (edit your links here)
- `js/checkout.js` — plan checkout window (Razorpay)
- `data/orders.json` — saved orders/payments (gitignored)
- `.env.example` — copy to `.env` and fill in Resend + Razorpay keys
- `package.json` — npm scripts (`npm run dev` / `npm start`)

## Deploying on Render

1. Push the project to GitHub (`.env` and the data files are already gitignored).
2. Render > New > Web Service > connect the repo. Build command: `npm install`. Start command: `npm start`.
3. Environment variables: `NODE_ENV=production`, `RESEND_API_KEY`, `RESEND_FROM`, `NOTIFY_EMAIL`,
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_KEY`. Don't set `PORT`.
4. Add the Razorpay webhook: `https://YOUR-SERVICE.onrender.com/api/razorpay/webhook`, event `payment.captured`.
5. **Saved data:** Render's disk is wiped on every redeploy/restart. Attach a Persistent Disk (paid plans),
   mount it at e.g. `/var/data`, and set `DATA_DIR=/var/data`. Until then, treat the notification emails and the
   Razorpay dashboard as your permanent records.
