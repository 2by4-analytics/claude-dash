#!/usr/bin/env node
// Generates src/data/agents.json for the Launchpad "Agents" panel by parsing
// the frontmatter of the agent .md files in the 2by4-agents repo
// (github.com/2by4-analytics/2by4-agents — the cloud home claude.ai/code opens).
//
// Dash has no GitHub token and the repo is private, so the panel can't fetch
// live — instead this runs locally and commits a static agents.json. Re-run it
// whenever you add/change an agent, then commit + push to deploy.
//
//   node scripts/gen-agents.mjs [agentsDir]
//   AGENTS_DIR=/path/to/.claude/agents node scripts/gen-agents.mjs
//
// Default source: ~/2by4-agents/.claude/agents

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_SLUG = '2by4-analytics/2by4-agents';
const SRC = process.env.AGENTS_DIR
  || process.argv[2]
  || join(process.env.HOME, '2by4-agents', '.claude', 'agents');
const OUT = join(__dirname, '..', 'src', 'data', 'agents.json');

// Per-agent curated emoji + launch prompt. Unknown agents fall back to sane
// defaults so a newly-added agent shows up automatically (just re-run this).
const OVERRIDES = {
  'facebook-ads-expert': {
    emoji: '📣',
    tagline: 'Meta strategist across both verticals — ecom ROAS/CAPI and lead-gen CPL/quality. Reads + appends the playbook ledgers.',
    prompt: "Use the facebook-ads-expert agent. Your two playbook ledgers live in this repo at clients/facebook-ads-playbook-ecom.md (sticker / ecom) and clients/facebook-ads-playbook-leadgen.md (sheds / services) — read the relevant one first, then I'll give you the account or the task.",
  },
  'google-ads-expert': {
    emoji: '🔍',
    tagline: 'Google Ads for lead-gen sheds + services — structure, bid strategy, conversion tracking, PMax vs Search.',
    prompt: "Use the google-ads-expert agent. I'll give you the Google Ads account and the task next.",
  },
  'wp-debugger': {
    emoji: '🛠',
    label: 'WP Debugger',
    tagline: 'WordPress debugging across the client sites — Elementor cache, REST quirks, iframe + CPT landmines.',
    prompt: "Use the wp-debugger agent. I'll describe the WordPress site and the issue next.",
  },
};

// Pretty labels for MCP server names (from the agent's mcpServers frontmatter).
const MCP_LABELS = {
  'meta-ads': 'Meta Ads',
  'claude_ai_ClickFunnels': 'ClickFunnels',
  'wp': 'WordPress',
};

function parseFrontmatter(md) {
  const lines = md.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'mcpServers' && val === '') {
      const list = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const lm = lines[j].match(/^\s*-\s*(.+?)\s*$/);
        if (!lm) break;
        list.push(lm[1].trim());
      }
      fm.mcpServers = list;
      i = j - 1;
    } else {
      fm[key] = val.trim();
    }
  }
  return fm;
}

function tagline(desc) {
  if (!desc) return '';
  let s = desc.split(/\.\s/)[0].trim();
  if (s.length > 130) s = s.slice(0, 127).replace(/\s+\S*$/, '') + '…';
  return s;
}

function builtinTools(toolsStr) {
  if (!toolsStr) return [];
  return toolsStr.split(',').map(t => t.trim())
    .filter(t => t && !t.startsWith('mcp__') && t !== 'ToolSearch');
}

function label(name) {
  return name.split(/[-_]/).map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

if (!existsSync(SRC)) {
  console.error(`Agents dir not found: ${SRC}\nPass a path or set AGENTS_DIR.`);
  process.exit(1);
}

const agents = readdirSync(SRC)
  .filter(f => f.endsWith('.md'))
  .map(f => {
    const fm = parseFrontmatter(readFileSync(join(SRC, f), 'utf8'));
    const name = fm.name || f.replace(/\.md$/, '');
    const ov = OVERRIDES[name] || {};
    return {
      name,
      label: ov.label || label(name),
      emoji: ov.emoji || '🤖',
      tagline: ov.tagline || tagline(fm.description),
      tools: builtinTools(fm.tools),
      mcp: (fm.mcpServers || []).map(s => MCP_LABELS[s] || s),
      model: fm.model || 'inherit',
      prompt: ov.prompt || `Use the ${name} agent. I'll give you a task next.`,
    };
  })
  .sort((a, b) => a.label.localeCompare(b.label));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ repo: REPO_SLUG, generatedFrom: SRC, agents }, null, 2) + '\n');
console.log(`Wrote ${agents.length} agents → ${OUT}`);
agents.forEach(a => console.log(`  ${a.emoji} ${a.label}  [${a.tools.length} tools${a.mcp.length ? ', MCP: ' + a.mcp.join('/') : ''}]`));
