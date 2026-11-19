// One-off (Alan 11-19): "URGENT: Your Order Is Stuck" email to every customer still in
// awaiting_customer in the bad-address flow. One email per customer, listing every stuck
// order's address. Replies come in from the same address, so address.js pendingFor() still
// parses them. Dry run unless APPLY=1. Run with: railway run node tools/_hb-addr-urgent.js
const axios = require('axios');
const ghl = require('../src/services/hb-support/ghl');

const SKIP_EMAILS = new Set(['diannemall@comcast.net']); // shirt; Brian is fixing it
const SIGNATURE = 'Happy baking!\nMaggie Bennett\nThe Happy Bakers';
const APPLY = process.env.APPLY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase()) || 'there';
const lines = (a) => [a.name, a.street1, a.street2, a.street3, `${a.city}, ${a.state} ${a.postalCode}`].filter((x) => x && String(x).trim()).join('\n');

const ss = axios.create({ baseURL: 'https://ssapi.shipstation.com', timeout: 30000, headers: { Authorization: `Basic ${Buffer.from(`${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`).toString('base64')}` } });
const HB = [4905682, 4905795, 4910136];

function text(first, addrs) {
  const one = addrs.length === 1;
  return [
    `Hi ${first},`,
    `Your Happy Bakers order is stuck and can't ship until we have a shipping address that works. The address we have came back as undeliverable:`,
    one ? addrs[0] : addrs.map((a, i) => `Order ${i + 1}:\n${a}`).join('\n\n'),
    `Please reply to this email with your full shipping address, including any apartment or unit number. If the address above is correct, just reply "looks good."`,
    `As soon as I hear back, I'll get your order on its way.`,
    SIGNATURE,
  ].join('\n\n');
}

(async () => {
  const st = (await axios.get(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/hb/support/address`, { headers: { 'x-dash-password': process.env.DASH_PASSWORD } })).data;
  const waiting = st.orders.filter((o) => o.status === 'awaiting_customer' && !SKIP_EMAILS.has(o.email));
  const byEmail = {};
  for (const o of waiting) (byEmail[o.email] ||= []).push(o);
  const log = [];
  let n = 0;
  for (const [email, orders] of Object.entries(byEmail)) {
    const addrs = []; let name = orders[0].name; let skip = null;
    for (const o of orders) {
      const list = ((await ss.get('/orders', { params: { orderNumber: o.order } })).data.orders || []).filter((x) => HB.includes(x.advancedOptions.storeId));
      await sleep(1600);
      const live = list.find((x) => x.orderStatus !== 'cancelled');
      if (live) { log.push(`  ${o.order} skipped: ShipStation has a live copy (${live.orderStatus})`); continue; }
      const t = (list[0] || {}).shipTo;
      if (t) { addrs.push(lines(t)); name = t.name || name; }
    }
    if (!addrs.length) { log.push(`SKIP ${email}: no stuck order left`); continue; }
    const c = await ghl.contactByEmail(email);
    if (c && (c.dnd || (c.dndSettings && c.dndSettings.Email && c.dndSettings.Email.status === 'active'))) skip = 'email DND on contact';
    if (skip) { log.push(`SKIP ${email}: ${skip}`); continue; }
    const body = text(firstName(name), [...new Set(addrs)]);
    if (n === 0) console.log(`--- sample to ${email} ---\nSubject: URGENT: Your Order Is Stuck\n\n${body}\n---`);
    if (APPLY) {
      try {
        const contactId = c ? c.id : await ghl.contactIdFor(email, firstName(name));
        await ghl.sendEmail({ contactId, to: email, fromName: 'Maggie Bennett', subject: 'URGENT: Your Order Is Stuck', text: body });
        log.push(`SENT ${email} (${orders.length} order${orders.length > 1 ? 's' : ''})`);
      } catch (e) { log.push(`FAIL ${email}: ${(e.response && JSON.stringify(e.response.data)) || e.message}`); }
      await sleep(2000);
    } else log.push(`would send ${email} (${addrs.length} address${addrs.length > 1 ? 'es' : ''})`);
    n++;
  }
  console.log(log.join('\n'));
  console.log(`\n${APPLY ? 'sent' : 'would send'}: ${n}`);
})().catch((e) => { console.error(e.response ? e.response.data : e); process.exit(1); });
