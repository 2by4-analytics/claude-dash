// One forced tool call to Claude → structured decision.
const axios = require('axios');

async function callTool({ system, tool, prompt }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const r = await axios.post('https://api.anthropic.com/v1/messages', {
    model: process.env.HB_SUPPORT_MODEL || 'claude-sonnet-5-5',
    max_tokens: 2000,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: prompt }],
  }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 90000 });
  const block = (r.data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('model returned no decision');
  return block.input;
}

module.exports = { callTool };
