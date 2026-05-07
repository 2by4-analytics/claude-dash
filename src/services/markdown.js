/**
 * Markdown helpers for editing client CLAUDE.md files in place.
 *
 * Mirrors the heading match in google.js (`## Open Items`, `## Tasks`, etc.)
 * so adds/toggles land in the same section the launchpad parses for display.
 */

const TASK_HEADING_RE = /^(tasks|open items|todo|to do|action items|to-do)\s*$/i;
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;
const HEADING_RE = /^##\s+(.+?)\s*$/;

/**
 * Toggle the first checkbox line that exactly matches `rawLine`.
 * Returns { content, changed }.
 *
 * Matching prefers exact equality on the original line; falls back to a
 * checkbox-aware match (same body text, ignoring the [ ]/[x] state) so a
 * race-y double-click after a state change still finds its line.
 */
function toggleCheckboxLine(content, rawLine) {
  const lines = content.split(/\r?\n/);
  const target = String(rawLine);
  const targetMatch = target.match(CHECKBOX_RE);
  const targetBody = targetMatch ? targetMatch[2] : null;

  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target) {
      lines[i] = flipCheckbox(lines[i]);
      changed = true;
      break;
    }
  }
  if (!changed && targetBody) {
    // Fallback: same body text, any state. Useful if the persisted state has
    // already changed since the client rendered.
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(CHECKBOX_RE);
      if (m && m[2] === targetBody) {
        lines[i] = flipCheckbox(lines[i]);
        changed = true;
        break;
      }
    }
  }
  return { content: lines.join('\n'), changed };
}

function flipCheckbox(line) {
  return line.replace(/\[([ xX])\]/, (_, state) => (state === ' ' ? '[x]' : '[ ]'));
}

/**
 * Append `- [ ] text` to the first recognized task-heading section.
 *
 * - If a `## Open Items` (or Tasks/Todo/Action Items) heading exists, the new
 *   line goes after the last existing list item in that section, before the
 *   next `## ` heading or EOF.
 * - If no such heading exists, append `\n## Open Items\n\n- [ ] text\n` to EOF.
 *
 * Multiple items are written in order with no blank line between them.
 */
function appendOpenItems(content, items) {
  const cleaned = items.map(s => String(s).trim()).filter(Boolean);
  if (!cleaned.length) return { content, added: 0 };

  const lines = content.split(/\r?\n/);
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && TASK_HEADING_RE.test(m[1])) { sectionStart = i; break; }
  }

  if (sectionStart === -1) {
    // No task heading yet — append a fresh section at EOF.
    let suffix = '';
    if (lines.length === 0 || lines[lines.length - 1].trim() !== '') suffix += '\n';
    suffix += '\n## Open Items\n\n';
    suffix += cleaned.map(t => `- [ ] ${t}`).join('\n');
    suffix += '\n';
    return { content: content + suffix, added: cleaned.length, createdSection: true };
  }

  // Find end of section: next ## heading, or EOF.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) { sectionEnd = i; break; }
  }

  // Within the section, find the last existing checkbox/list item line so we
  // append directly after it (preserves any intro paragraph and trailing
  // blank lines before the next heading).
  let insertAt = sectionStart + 1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (CHECKBOX_RE.test(lines[i]) || /^\s*[-*]\s+/.test(lines[i])) insertAt = i + 1;
  }
  // If insertAt landed right after the heading and the next line is blank,
  // skip the blank so the bullet hugs the heading like an empty section.
  if (insertAt === sectionStart + 1 && lines[insertAt] !== undefined && lines[insertAt].trim() === '') {
    insertAt += 1;
  }

  const newLines = cleaned.map(t => `- [ ] ${t}`);
  lines.splice(insertAt, 0, ...newLines);
  return { content: lines.join('\n'), added: cleaned.length, createdSection: false };
}

function appendOpenItem(content, text) {
  return appendOpenItems(content, [text]);
}

module.exports = { toggleCheckboxLine, appendOpenItem, appendOpenItems };
