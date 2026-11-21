'use strict';
// Status of the default start (default-start.js) for the preview page: a status line on the "Preview not running"
// page, or the friendly waiting page while installing or starting.
// The state file is written by project-writable code, so it is untrusted input: only a regular file (no
// symlink) below a small size cap is read, only the five known states are accepted, the reason is
// control-character-stripped, length-capped and HTML-escaped, and no log content is ever rendered.
// Anything else gives null, which is the page as it was before the default start existed.
const fs = require('node:fs');
const path = require('node:path');

const STATES = new Set(['installing', 'starting', 'running', 'failed', 'none']);
const MAX_STATE_BYTES = 2048;
const MAX_REASON = 200;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// -> { html, refresh } or { waiting: true, refresh: true } (installing, starting) or null.
function defaultStartStatus(projectDir, stateDir = '/tmp') {
  if (!projectDir) return null;
  // A repository's own start.sh always wins: its page is the unchanged one.
  if (isFile(path.join(projectDir, '.liivo', 'start.sh'))) return null;
  const name = path.basename(projectDir);
  const file = path.join(stateDir, `liivo-start-${name}.state`);
  let data;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_STATE_BYTES) return null;
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.state !== 'string' || !STATES.has(data.state)) return null;
  const reason =
    typeof data.reason === 'string'
      ? escapeHtml(
          // eslint-disable-next-line no-control-regex
          data.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_REASON)
        )
      : '';
  const logPath = escapeHtml(`/tmp/liivo-start-${name}.log`);
  switch (data.state) {
    case 'installing':
    case 'starting':
      // Both render the same friendly waiting page; nothing from the state file is shown.
      return { waiting: true, refresh: true };
    case 'failed':
      return { html: `<p>The default start failed: ${reason || 'unknown reason'}. See ${logPath}.</p>`, refresh: false };
    case 'none':
      return {
        html: `<p>Nothing to start: ${reason || 'unknown reason'}. Add .liivo/start.sh to start the project.</p>`,
        refresh: false,
      };
    default:
      return null; // running: the dev server is up or about to answer, nothing to add
  }
}

module.exports = { defaultStartStatus };
