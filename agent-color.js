#!/usr/bin/env node
// agent-color "<agent name>": prints the agent's color (#rrggbb), assigning one when it has none.
// Installed beside the status line as ~/.claude/hooks/agent-color. The registry it keeps,
// ~/.claude/agent-colors.json ({ "<name>": { color, assigned } }, keyed by the agent's spawn
// description), is read by `statusline.js subagent` to color each agent's row, so the agent
// panel and the chat (reply-colors `{#rrggbb}(text)` markers) give one agent one color.
//
// A new agent gets the palette color least used among entries assigned in the last 24 h (ties:
// palette order); entries older than 7 days are dropped. The read-modify-write runs under a lock
// file and lands through a temp file + rename, so two calls at once neither corrupt the file nor
// lose each other's entry.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mirrors AGENT_PALETTE in statusline.js (a test keeps them equal). Readable on a dark terminal
// and clear of the colors that already mean something: green (recommended), red (broken),
// magenta/pink (pending), gray (notes), the context bar's yellow/orange, and the orchestrator's
// own blue (#5bb8f5), which only the main session's question and review blocks use. Each color is
// at least CIELAB ΔE 25 from the default text, those reserved colors and every other palette color
// (test/agent-color.test.js lists them), so an agent's name never reads as one of them.
const PALETTE = ['#c78bf0', '#3fc9b0', '#fca8a0', '#6888f8', '#8cb084', '#a8e6ef', '#c2b5f7'];

const RECENT_MS = 24 * 60 * 60 * 1000;   // window counted when picking the least-used color
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;  // entries older than this are dropped
const LOCK_WAIT_MS = 3000;                // give up waiting for the lock after this
const LOCK_STALE_MS = 10000;              // a lock older than this was left by a crashed call
const HEX_RE = /^#[0-9a-f]{6}$/i;

function registryFile() {
  return path.join(os.homedir(), '.claude', 'agent-colors.json');
}

function assignedAt(entry) {
  const t = Date.parse(entry && entry.assigned);
  return Number.isNaN(t) ? null : t;
}

// Pure: the registry after looking up (or assigning) `name` at `now`, and the name's color.
// Entries that are malformed or older than KEEP_MS are dropped first; `name`'s own entry is
// reassigned when its color is no longer in PALETTE.
function assignColor(registry, name, now = Date.now()) {
  const kept = {};
  for (const [key, entry] of Object.entries(registry || {})) {
    const t = assignedAt(entry);
    if (t === null || !HEX_RE.test(entry.color) || now - t > KEEP_MS) continue;
    kept[key] = entry;
  }
  // A color the palette no longer holds is reassigned when its agent is next asked for; other
  // agents' retired entries keep theirs until then, so a running agent's row doesn't change color.
  if (kept[name] && PALETTE.includes(kept[name].color.toLowerCase())) {
    return { registry: kept, color: kept[name].color.toLowerCase() };
  }

  const uses = new Map(PALETTE.map(c => [c, 0]));
  for (const entry of Object.values(kept)) {
    const color = entry.color.toLowerCase();
    if (uses.has(color) && now - assignedAt(entry) <= RECENT_MS) uses.set(color, uses.get(color) + 1);
  }
  let color = PALETTE[0];
  for (const c of PALETTE) if (uses.get(c) < uses.get(color)) color = c;

  kept[name] = { color, assigned: new Date(now).toISOString() };
  return { registry: kept, color };
}

function readRegistry(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs fn while holding <file>.lock (created exclusively). A lock left by a crashed call is
// taken over once stale; if the lock can't be had in time, fn runs anyway (the rename still
// keeps the file whole, at worst one concurrent entry is lost).
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch (e2) {}
      if (Date.now() > deadline) break;
      sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    if (held) try { fs.unlinkSync(lock); } catch (e) {}
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The color of `name`, assigning and saving one when needed.
function agentColor(name, now = Date.now()) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const before = readRegistry(file);
    const { registry, color } = assignColor(before, name, now);
    if (JSON.stringify(registry) !== JSON.stringify(before)) writeAtomic(file, registry);
    return color;
  });
}

if (require.main === module) {
  const name = process.argv.slice(2).join(' ').trim();
  if (!name) {
    process.stderr.write('usage: agent-color "<agent name>"\n');
    process.exit(2);
  }
  try {
    process.stdout.write(agentColor(name) + '\n');
  } catch (e) {
    process.stderr.write(`agent-color: ${e.message}\n`);
    process.exit(1);
  }
} else {
  module.exports = { PALETTE, RECENT_MS, KEEP_MS, assignColor, agentColor, registryFile };
}
