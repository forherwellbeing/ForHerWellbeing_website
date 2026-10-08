// Zoho CRM integration: pushes website inquiries and paid orders into Zoho CRM as Leads.
// If the ZOHO_* variables are not set, every function here quietly does nothing.

const DATA_CENTERS = {
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
};

const DC = DATA_CENTERS[(process.env.ZOHO_DC || 'in').toLowerCase()] || DATA_CENTERS.in;
const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;

const enabled = Boolean(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN);
if (!enabled) {
  console.warn('[zoho] ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN not set. Zoho CRM sync is off.');
}

let cachedToken = null;
let cachedUntil = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const body = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${DC.accounts}/oauth/v2/token`, { method: 'POST', body });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedUntil = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
  return cachedToken;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { First_Name: '', Last_Name: parts[0] || 'Website Visitor' };
  return { First_Name: parts.slice(0, -1).join(' '), Last_Name: parts[parts.length - 1] };
}

// Create the lead, or update it if one with the same email already exists.
async function upsertLead(fields) {
  const token = await getAccessToken();
  const res = await fetch(`${DC.api}/crm/v6/Leads/upsert`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [fields], duplicate_check_fields: ['Email'] }),
  });
  const data = await res.json();
  const row = data && data.data && data.data[0];
  if (!res.ok || !row || row.status !== 'success') {
    throw new Error('Zoho upsert failed: ' + JSON.stringify(data));
  }
  return row.details && row.details.id;
}

async function addNote(leadId, title, content) {
  const token = await getAccessToken();
  const res = await fetch(`${DC.api}/crm/v6/Leads/${leadId}/Notes`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [{ Note_Title: title, Note_Content: content }] }),
  });
  if (!res.ok) throw new Error('Zoho note failed: ' + (await res.text()));
}

// Called after a contact form submission is saved.
async function syncInquiry(inquiry) {
  if (!enabled) return;
  const leadId = await upsertLead({
    ...splitName(inquiry.name),
    Email: inquiry.email,
    Phone: inquiry.phone,
    Lead_Source: 'Website',
    Description: `Interest: ${inquiry.interest}\n\n${inquiry.message || '(no message)'}\n\nSubmitted: ${inquiry.submittedAt}`,
  });
  if (leadId) {
    await addNote(leadId, `Website inquiry: ${inquiry.interest}`, inquiry.message || '(no message)');
  }
}

// Called once when Razorpay confirms an order is paid.
async function syncPaidOrder(order, paymentId) {
  if (!enabled) return;
  const amount = (order.amount / 100).toLocaleString('en-IN');
  const leadId = await upsertLead({
    ...splitName(order.name),
    Email: order.email,
    Phone: order.phone,
    Lead_Source: 'Website',
  });
  if (leadId) {
    await addNote(
      leadId,
      `PAID: ${order.planName} (INR ${amount})`,
      [
        `Plan: ${order.planName}`,
        `Amount: INR ${amount}`,
        `Razorpay payment ID: ${paymentId}`,
        `Paid at: ${order.paidAt}`,
      ].join('\n')
    );
  }
}

module.exports = { syncInquiry, syncPaidOrder, enabled };