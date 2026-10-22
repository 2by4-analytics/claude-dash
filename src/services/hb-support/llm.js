// One forced tool call to Claude → structured decision.
const axios = require('axios');

// `images` (optional): [{ media_type, data }] base64 images sent ahead of the prompt.
async function callTool({ system, tool, prompt, images = [] }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  // Forced tool_choice isn't supported on current models, so ask for the call and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.HB_SUPPORT_MODEL || 'claude-sonnet-5-5',
      max_tokens: 4000,
      system: `${system}\n\nAlways answer by calling the ${tool.name} tool exactly once. Do not answer in plain text.`,
      tools: [tool],
      messages: [{ role: 'user', content: images.length ? [...images.map((i) => ({ type: 'image', source: { type: 'base64', ...i } })), { type: 'text', text: prompt }] : prompt }],
    }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
    const block = (r.data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (block) return block.input;
  }
  throw new Error('model returned no decision');
}

module.exports = { callTool };
