// Pure forecast math for the inventory agent (no I/O, so it can be checked locally).
//
// The Box is a monthly kit whose CONTENTS are set by calendar month (Box Calendar tab):
// a rebill charged in November ships November's item, whatever cycle it is. Rebills
// before the first calendar month ship the first month's item (Oct 30–31 → Nov scale),
// and nobody gets the same month twice: a second charge inside a month they already
// got (Oct 30 → Nov 29) ships the NEXT month's item.
//
// Demand = live subscriptions' scheduled rebills (and their later 30-day rebills)
// + projected new signups (first rebill 14 days after signup) + one-off sales of the
// item, each rebill weighted by the measured first-rebill success rate. Stock = units
// bought (Inventory tab, in transit included) − boxes already billed − one-offs sold.

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const monthOf = (iso) => iso.slice(0, 7);
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

/**
 * @param today          'YYYY-MM-DD' (Central)
 * @param calendar       [{month:'2026-11', sku:'SCALE'|null}] sorted
 * @param subs           box subscriptions: {created, status, live, nextBillDate, intervalDays, trialDays, boxBills:[date]}
 * @param oneOffSales    [{date, sku, qty}] one-off orders of calendar items (already sold)
 * @param inventory      Inventory tab rows [{sku, qty, unitCost, date}]
 * @param cfg            {leadDays, reviewDays, bufferPct, signupsPerDay|null, minResolved}
 */
function forecast({ today, calendar, subs, oneOffSales, inventory, cfg }) {
  const firstMonth = calendar.length ? calendar[0].month : monthOf(today);
  const boxMonth = (iso) => (monthOf(iso) < firstMonth ? firstMonth : monthOf(iso));
  const skuFor = Object.fromEntries(calendar.map((c) => [c.month, c.sku]));
  let horizon = calendar.length ? calendar[calendar.length - 1].month : monthOf(today);
  for (let m = monthOf(today), i = 0; i < 2; i++) { m = nextMonth(m); if (m > horizon) horizon = m; }
  const horizonEnd = monthEnd(horizon);

  // First-rebill success rate, from subs whose first rebill was due at least a day ago.
  // Cancels before day 14 count as misses, the same way they'll thin the live subs.
  const resolved = subs.filter((s) => addDays(s.created, s.trialDays) < addDays(today, -1));
  const billed = resolved.filter((s) => s.boxBills.length > 0);
  const measured = resolved.length >= cfg.minResolved;
  const rate = measured ? billed.length / resolved.length : 1;

  // Signup pace: trailing 7 full days unless Settings pins one.
  const created = subs.map((s) => s.created);
  const last7 = created.filter((d) => d >= addDays(today, -7) && d < today).length;
  const signupsPerDay = cfg.signupsPerDay != null ? cfg.signupsPerDay : last7 / 7;
  const signedToday = created.filter((d) => d === today).length;

  // Each subscriber's charges, in order, get consecutive box months: never earlier than
  // the charge's own month or the first calendar month, never a month they already got.
  const assign = (dates, lastMonth) => dates.map((d) => {
    let m = boxMonth(d);
    if (lastMonth && m <= lastMonth) m = nextMonth(lastMonth);
    lastMonth = m;
    return { d, m };
  });

  // Expected boxes per bill date and box month, today → horizon.
  const entries = [];
  const chainDates = (first, every) => { const out = []; for (let d = first; d <= horizonEnd; d = addDays(d, every)) out.push(d); return out; };
  const boxesBilledByMonth = {};
  let liveCount = 0;
  for (const s of subs) {
    const past = assign([...s.boxBills].sort(), null);
    for (const b of past) boxesBilledByMonth[b.m] = (boxesBilledByMonth[b.m] || 0) + 1;
    if (!s.live || !s.nextBillDate) continue;
    liveCount++;
    const future = assign(chainDates(s.nextBillDate < today ? today : s.nextBillDate, s.intervalDays), past.length ? past[past.length - 1].m : null);
    for (const e of future) entries.push({ ...e, n: rate });
  }
  const trial = subs[0] ? subs[0].trialDays : 14;
  const interval = subs[0] ? subs[0].intervalDays : 30;
  for (let d = today; addDays(d, trial) <= horizonEnd; d = addDays(d, 1)) {
    const n = d === today ? Math.max(0, signupsPerDay - signedToday) : signupsPerDay;
    if (n > 0) for (const e of assign(chainDates(addDays(d, trial), interval), null)) entries.push({ ...e, n: n * rate });
  }

  // Box demand by box month (what the calendar has to cover).
  const months = {};
  for (const e of entries) months[e.m] = (months[e.m] || 0) + e.n;

  // Per item on the calendar.
  const skus = [...new Set(calendar.map((c) => c.sku).filter(Boolean))];
  const items = skus.map((sku) => {
    const its = calendar.filter((c) => c.sku === sku).map((c) => c.month);
    const lastDay = monthEnd(its[its.length - 1]);
    const perDay = {};
    for (const e of entries) if (its.includes(e.m)) perDay[e.d] = (perDay[e.d] || 0) + e.n;
    const bought = inventory.filter((r) => r.sku === sku).reduce((a, r) => a + r.qty, 0);
    const spent = inventory.filter((r) => r.sku === sku).reduce((a, r) => a + r.qty * (r.unitCost || 0), 0);
    const usedBoxes = its.reduce((a, m) => a + (boxesBilledByMonth[m] || 0), 0);
    const sold = oneOffSales.filter((o) => o.sku === sku);
    const usedOneOff = sold.reduce((a, o) => a + o.qty, 0);
    const oneOffPerDay = sold.filter((o) => o.date >= addDays(today, -7) && o.date < today).reduce((a, o) => a + o.qty, 0) / 7;
    const remaining = bought - usedBoxes - usedOneOff;

    // Walk the days left in the item's months.
    let cum = 0, stockout = null;
    const cumBy = {};
    // From today: a later month's item can be needed early (Nov 29 second charge → Dec item).
    for (let d = today; d <= lastDay; d = addDays(d, 1)) {
      cum += (perDay[d] || 0) + oneOffPerDay;
      cumBy[d] = cum;
      if (stockout == null && cum > remaining) stockout = d;
    }
    const totalDemand = cum;
    const coverEnd = [lastDay, addDays(today, cfg.leadDays + cfg.reviewDays)].sort()[0];
    const needThrough = (d) => { let best = 0; for (const [k, v] of Object.entries(cumBy)) if (k <= d) best = v; return best; };
    const buffer = 1 + cfg.bufferPct / 100;
    const orderNow = Math.max(0, Math.ceil(needThrough(coverEnd) * buffer - remaining));
    const toFinish = Math.max(0, Math.ceil(totalDemand * buffer - remaining));
    const arrives = addDays(today, cfg.leadDays);
    const urgent = stockout != null && stockout <= addDays(today, cfg.leadDays + cfg.reviewDays);
    return {
      sku, months: its, lastDay, bought, spent, unitCost: bought ? spent / bought : null,
      usedBoxes, usedOneOff, remaining, oneOffPerDay, totalDemand, stockout,
      leftover: stockout ? 0 : Math.floor(remaining - totalDemand),
      action: urgent && orderNow > 0 ? 'order_now' : stockout ? 'watch' : 'covered',
      orderNow: urgent ? orderNow : 0, coverEnd, arrives, toFinish,
      orderBy: stockout ? addDays(stockout, -cfg.leadDays) : null,
      lateRisk: stockout != null && stockout < arrives,
    };
  });

  // Months coming up with no item chosen yet.
  const gaps = [];
  for (let m = firstMonth > monthOf(today) ? firstMonth : monthOf(today); m <= horizon; m = nextMonth(m)) {
    if (!skuFor[m]) {
      const firstBill = entries.filter((e) => e.m === m).map((e) => e.d).sort()[0] || `${m}-01`;
      gaps.push({ month: m, boxes: Math.round(months[m] || 0), firstBill, daysAway: daysBetween(today, firstBill) });
    }
  }
  // Charges near the horizon spill into the month after it; that month is only partly counted.
  for (const m of Object.keys(months)) if (m > horizon) delete months[m];

  return {
    today, firstMonth, horizon, rate, measured, resolved: resolved.length, billed: billed.length,
    signupsPerDay, signupsPinned: cfg.signupsPerDay != null, liveCount, months, boxesBilledByMonth, items, gaps,
  };
}

module.exports = { forecast, addDays, monthOf, monthEnd, nextMonth };
