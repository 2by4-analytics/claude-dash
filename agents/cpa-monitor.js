#!/usr/bin/env node
/**
 * 2by4 LLC — CPA Monitor Agent
 * 
 * Pulls today's data from the Media Dashboard API for all clients,
 * compares CPP against each ad account's target, and outputs a
 * structured daily briefing with recommended actions.
 * 
 * Usage:
 *   node agents/cpa-monitor.js
 *   node agents/cpa-monitor.js --date 2026-03-26
 *   node agents/cpa-monitor.js --client eric
 */

const DASHBOARD_URL = 'https://claude-dash-production.up.railway.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'your-password-here';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const AUTH_HEADER = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');

// --- Date helpers ---
function today() {
  return new Date().toISOString().split('T')[0];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { date: today(), client: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') opts.date = args[++i];
    if (args[i] === '--client') opts.client = args[++i];
  }
  return opts;
}

// --- API calls ---
async function fetchClients() {
  const res = await fetch(`${DASHBOARD_URL}/api/clients`, {
    headers: { Authorization: AUTH_HEADER }
  });
  if (!res.ok) throw new Error(`/api/clients failed: ${res.status}`);
  return res.json();
}

async function fetchDashboard(clientId, date) {
  const url = `${DASHBOARD_URL}/api/dashboard/${clientId}?startDate=${date}&endDate=${date}`;
  const res = await fetch(url, {
    headers: { Authorization: AUTH_HEADER }
  });
  if (!res.ok) throw new Error(`/api/dashboard/${clientId} failed: ${res.status}`);
  return res.json();
}

// --- Data processing ---
// Walk the nested account > campaign > adset > ad tree
// and collect every node with spend >= minSpend
function collectRows(data, minSpend = 25) {
  const rows = [];

  function walk(node, level) {
    if (!node) return;
    const spend = parseFloat(node.spend) || 0;
    const cpp = parseFloat(node.cpp) || null;
    const sales = parseInt(node.sales) || 0;

    if (spend >= minSpend && cpp !== null) {
      rows.push({
        level,          // account | campaign | adset | ad
        name: node.name,
        accountName: node.accountName || node.name,
        cpp,
        cppTarget: parseFloat(node.cppTarget) || null,
        spend,
        sales,
        deltaCpp: parseFloat(node.deltaCpp) || null,
        deltaCppPct: parseFloat(node.deltaCppPct) || null,
        convRate: parseFloat(node.convRate) || null,
        declineRate: parseFloat(node.declineRate) || null,
      });
    }

    // Recurse into children (campaigns, adsets, ads)
    const children = node.campaigns || node.adsets || node.ads || [];
    for (const child of children) {
      walk({ ...child, accountName: node.accountName || node.name, cppTarget: child.cppTarget || node.cppTarget }, level === 'account' ? 'campaign' : level === 'campaign' ? 'adset' : 'ad');
    }
  }

  // data may be an array of accounts or a single account
  const accounts = Array.isArray(data) ? data : [data];
  for (const account of accounts) {
    walk({ ...account, cppTarget: account.cppTarget }, 'account');
  }

  return rows;
}

function categorize(rows) {
  const overTarget = [];
  const nearTarget = [];   // within 10% over
  const winners = [];      // 15%+ under target
  const onTrack = [];

  for (const row of rows) {
    if (!row.cppTarget) continue;
    const pctOver = (row.cpp - row.cppTarget) / row.cppTarget;

    if (pctOver > 0.10) {
      overTarget.push({ ...row, pctOver });
    } else if (pctOver > 0) {
      nearTarget.push({ ...row, pctOver });
    } else if (pctOver < -0.15) {
      winners.push({ ...row, pctOver });
    } else {
      onTrack.push({ ...row, pctOver });
    }
  }

  return { overTarget, nearTarget, winners, onTrack };
}

// --- Claude analysis ---
async function analyzeWithClaude(clientName, date, rows, categorized) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY set — skipping Claude analysis');
    return null;
  }

  const dataStr = JSON.stringify({
    client: clientName,
    date,
    summary: {
      totalSpend: rows.reduce((s, r) => s + r.spend, 0).toFixed(2),
      totalSales: rows.filter(r => r.level === 'ad').reduce((s, r) => s + r.sales, 0),
    },
    overTarget: categorized.overTarget.map(r => ({
      name: r.name, level: r.level, cpp: r.cpp, target: r.cppTarget,
      overBy: (r.cpp - r.cppTarget).toFixed(2), spend: r.spend.toFixed(2),
      trend: r.deltaCpp > 0 ? `worsening +$${r.deltaCpp?.toFixed(2)}` : `improving $${r.deltaCpp?.toFixed(2)}`
    })),
    winners: categorized.winners.map(r => ({
      name: r.name, level: r.level, cpp: r.cpp, target: r.cppTarget,
      underBy: (r.cppTarget - r.cpp).toFixed(2), spend: r.spend.toFixed(2)
    })),
    nearTarget: categorized.nearTarget.map(r => ({
      name: r.name, level: r.level, cpp: r.cpp, target: r.cppTarget, spend: r.spend.toFixed(2)
    }))
  }, null, 2);

  const prompt = `You are a paid media analyst for a Meta ads agency. Analyze today's performance data and give a concise, actionable briefing.

DATA:
${dataStr}

Provide:
1. ONE sentence overall assessment
2. PAUSE: List any ads to pause (CPP significantly over target and worsening)
3. SCALE: List any ads to increase budget (CPP well under target with meaningful spend)
4. WATCH: List items that need monitoring but no action yet
5. ONE key insight or pattern you notice

Be direct and specific. Use dollar amounts. No fluff.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  return data.content?.[0]?.text || null;
}

// --- Output formatting ---
function printBriefing(clientName, date, rows, categorized, aiAnalysis) {
  const totalSpend = rows.reduce((s, r) => r.level === 'account' ? s + r.spend : s, 0);

  console.log('\n' + '='.repeat(60));
  console.log(`  CPA MONITOR — ${clientName.toUpperCase()} — ${date}`);
  console.log('='.repeat(60));
  console.log(`  Total Spend: $${totalSpend.toFixed(2)}`);
  console.log('');

  if (categorized.overTarget.length) {
    console.log('🔴 OVER TARGET (action needed):');
    for (const r of categorized.overTarget) {
      const trend = r.deltaCpp > 0 ? `▲ worsening` : `▼ improving`;
      console.log(`  [${r.level.toUpperCase()}] ${r.name}`);
      console.log(`    CPP: $${r.cpp.toFixed(2)} | Target: $${r.cppTarget} | Over by: $${(r.cpp - r.cppTarget).toFixed(2)} (${(r.pctOver * 100).toFixed(0)}%) | Spend: $${r.spend.toFixed(2)} | ${trend}`);
    }
    console.log('');
  }

  if (categorized.winners.length) {
    console.log('🟢 WINNERS (consider scaling):');
    for (const r of categorized.winners) {
      console.log(`  [${r.level.toUpperCase()}] ${r.name}`);
      console.log(`    CPP: $${r.cpp.toFixed(2)} | Target: $${r.cppTarget} | Under by: $${(r.cppTarget - r.cpp).toFixed(2)} | Spend: $${r.spend.toFixed(2)}`);
    }
    console.log('');
  }

  if (categorized.nearTarget.length) {
    console.log('🟡 NEAR TARGET (watch):');
    for (const r of categorized.nearTarget) {
      console.log(`  [${r.level.toUpperCase()}] ${r.name}`);
      console.log(`    CPP: $${r.cpp.toFixed(2)} | Target: $${r.cppTarget} | Spend: $${r.spend.toFixed(2)}`);
    }
    console.log('');
  }

  if (categorized.onTrack.length) {
    console.log('✅ ON TRACK:');
    for (const r of categorized.onTrack) {
      console.log(`  [${r.level.toUpperCase()}] ${r.name} — CPP: $${r.cpp.toFixed(2)} / $${r.cppTarget}`);
    }
    console.log('');
  }

  if (aiAnalysis) {
    console.log('─'.repeat(60));
    console.log('🤖 AI ANALYSIS:');
    console.log('');
    console.log(aiAnalysis);
    console.log('');
  }

  console.log('='.repeat(60));
}

// --- Main ---
async function main() {
  const opts = parseArgs();
  console.log(`\nFetching clients...`);

  const clients = await fetchClients();
  const targets = opts.client
    ? clients.filter(c => c.id === opts.client || c.name.toLowerCase() === opts.client.toLowerCase())
    : clients;

  if (!targets.length) {
    console.error(`No clients found${opts.client ? ` matching "${opts.client}"` : ''}`);
    process.exit(1);
  }

  for (const client of targets) {
    console.log(`Fetching dashboard for ${client.name} (${opts.date})...`);

    try {
      const data = await fetchDashboard(client.id, opts.date);
      const rows = collectRows(data);

      if (!rows.length) {
        console.log(`  No data with sufficient spend for ${client.name}`);
        continue;
      }

      const categorized = categorize(rows);
      const aiAnalysis = await analyzeWithClaude(client.name, opts.date, rows, categorized);
      printBriefing(client.name, opts.date, rows, categorized, aiAnalysis);

    } catch (err) {
      console.error(`  Error fetching ${client.name}: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
