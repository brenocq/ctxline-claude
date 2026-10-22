#!/usr/bin/env node
// Claude Code statusline: dir │ model │ context │ usage │ cost │ task
// https://github.com/MithunWijayasiri/ctxline-claude

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');

// Lives here, not package.json: this file ships standalone to ~/.claude/hooks/. Must match package.json.
const VERSION = '1.7.5';

const IS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Segment opt-out: comma list. Recognized: branch, effort, cost, task, update, autoupdate, usage.
// Disabling skips the work, not just the output; dir/model/context always render.
// autoupdate: no self-install, the "available" row stays; update: no check at all.
const DISABLED = new Set(
  (process.env.CTXLINE_DISABLE || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// Context bar width in cells. Each cell is a 6-dot braille glyph filled one dot at a time, left
// column top to bottom, then the right one, so the bar grows in 1/36 steps of the window. Cells
// with no dot yet are a gray ⠿, the track; a glyph has one color, so a part-filled cell shows
// only its filled dots.
const BAR_WIDTH = 6;
const BAR_CELLS = ['\u2800', '\u2801', '\u2803', '\u2807', '\u280f', '\u281f', '\u283f']; // ⠀⠁⠃⠇⠏⠟⠿
const BAR_DOTS = BAR_CELLS.length - 1;

// Branch names tail-truncated to this with "…", keeping leading ticket IDs visible.
const MAX_BRANCH_LEN = 24;

const SEGMENT_SEP = ' │ ';

// Cells reserved at the terminal edge when deciding to wrap; 0 = full width.
const WIDTH_MARGIN = 0;

// Cache configuration
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache.json');
const FRESH_TTL_MS = 30000;            // fresh: render cache, skip API
const STALE_TTL_MS = 10 * 60 * 1000;   // stale: fallback only when a live call fails

// Single-entry ahead/behind cache: throttles the one git subprocess to once per render burst.
const GIT_CACHE_FILE = path.join(CACHE_DIR, 'git-cache.json');
const GIT_FRESH_TTL_MS = 5000;          // 5s: reuse counts within a render burst
const GIT_STALE_TTL_MS = 60000;         // 60s: fall back to last counts if git fails
const GIT_TIMEOUT_MS = 500;             // hard cap on the rev-list subprocess (warm ~130ms)

// Update check: render only reads this cache; the registry fetch runs in a detached child.
const UPDATE_CACHE_FILE = path.join(CACHE_DIR, 'update-cache.json');
const UPDATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 3 days between successful checks
const UPDATE_RETRY_MS = 60 * 60 * 1000;         // 1h backoff after a failed/killed check or install
const UPDATE_TIMEOUT_MS = 2000;                 // socket idle AND whole-request deadline
const UPDATED_NOTICE_MS = 5000;                 // "updated" row lifetime, from its first render
const REGISTRY_HOST = 'registry.npmjs.org';
const RELEASE_HOST = 'raw.githubusercontent.com';
const RELEASE_REPO = 'MithunWijayasiri/ctxline-claude';
const PACKAGE_NAME = 'ctxline-claude';
// Self-install only over the installed hook — never a working-tree copy under local testing.
const HOOK_FILE = path.join(os.homedir(), '.claude', 'hooks', 'statusline.js');
const SEMVER_RE = /^\d+\.\d+\.\d+$/;       // releases only: a prerelease never nudges

// Subagent mode reads only stdin (no fetch to race), so its read gets its own short cap.
const SUBAGENT_TIMEOUT_MS = 500;

// Each subagent's name is drawn in its own color: the one `agent-color` (agent-color.js, installed
// beside this file) assigned it in AGENT_COLORS_FILE, read here only, never written; an agent
// missing from it gets a stable hash of its name into the palette. Mirrors PALETTE in
// agent-color.js (a test keeps them equal).
const AGENT_COLORS_FILE = path.join(os.homedir(), '.claude', 'agent-colors.json');
const AGENT_PALETTE = ['#5bb8f5', '#c78bf0', '#3fc9b0', '#f4a582', '#7b8cff', '#d8c8a0', '#a8e6ef', '#c2b5f7'];
// A subagent row's live activity is cut to fit the terminal; with no known width, to this.
const ACTIVITY_MAX = 48;
// Cells the agent panel draws before each row (its own bullet and indent).
const SUBAGENT_ROW_INDENT = 4;

// Each subagent's cost, from its transcript (<session>/subagents/agent-<id>.jsonl beside stdin's
// transcript_path). Read from where the last render stopped, the offset and running total kept
// per file; at most COST_MAX_READ per render, so a first read of a long transcript never stalls
// the row (it catches up over a few renders).
const COST_CACHE_DIR = path.join(CACHE_DIR, 'tokens');
const COST_MAX_READ = 16 * 1024 * 1024;
// Bumped when the state file's shape changes, so an older one is counted again from the start.
const COST_STATE_VERSION = 2;
// One reply is logged several times while it streams, the last record's usage the one that
// counts: the latest message ids are kept so a later record replaces an earlier one's cost.
const COST_RECENT_IDS = 64;
// A state file untouched this long belongs to a transcript no longer written to; it is deleted
// when a new one is created (the only time the directory grows), so it never piles up.
const COST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// $ per million tokens, copied from Claude Code's model catalog (2.1.307) so a subagent's cost
// is priced as the session's own cost.total_cost_usd is. Add a model here when one launches;
// an unknown one is priced as DEFAULT_PRICE, as Claude Code does.
const price = (input, output, cacheRead) => ({ in: input, out: output, w5m: input * 1.25, w1h: input * 2, read: cacheRead });
const DEFAULT_PRICE = price(5, 25, 0.5);
const MODEL_PRICES = {
  'claude-3-5-haiku': price(0.8, 4, 0.08),
  'claude-haiku-4-5': price(1, 5, 0.1),
  'claude-haiku-5-5': { ...price(0.1, 0.5, 0.01), long: { above: 1e5, ...price(0.5, 2.5, 0.05) } },
  'claude-3-5-sonnet': price(3, 15, 0.3),
  'claude-3-7-sonnet': price(3, 15, 0.3),
  'claude-sonnet-4-0': price(3, 15, 0.3),
  'claude-sonnet-4-5': price(3, 15, 0.3),
  'claude-sonnet-4-6': price(3, 15, 0.3),
  'claude-sonnet-5': price(2, 10, 0.2),
  'claude-sonnet-5-5': price(2, 10, 0.1),
  'claude-opus-4-0': price(15, 75, 1.5),
  'claude-opus-4-1': price(15, 75, 1.5),
  'claude-opus-4-5': price(5, 25, 0.5),
  'claude-opus-4-6': price(5, 25, 0.5),
  'claude-opus-4-7': price(5, 25, 0.5),
  'claude-opus-4-8': price(5, 25, 0.5),
  'claude-opus-5': price(5, 25, 0.5),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-fable-5': price(10, 50, 1),
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-mythos-5': price(10, 50, 1),
  'claude-mythos-5-1': price(10, 50, 0.25)
};
// Fast mode (usage.speed "fast") has its own rates; other models keep their standard ones.
const FAST_PRICES = {
  'claude-opus-5-5': price(8, 40, 0.4),
  'claude-opus-5': price(10, 50, 1),
  'claude-opus-4-8': price(10, 50, 1),
  'claude-opus-4-7': price(30, 150, 3),
  'claude-opus-4-6': price(30, 150, 3)
};

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  purple: '\x1b[38;5;135m',
  gray: '\x1b[38;5;238m'
};

// Levels rank low<medium<high<xhigh<max<ultracode; only max (red) and ultracode (purple) stand out.
function getEffortColor(level) {
  const lvl = String(level).toLowerCase();
  if (lvl === 'max') return colors.red;
  if (lvl === 'ultracode') return colors.purple;
  return colors.dim;
}

function getUsageColor(percentage) {
  if (percentage < 60) return colors.green;
  if (percentage < 80) return colors.yellow;
  if (percentage < 90) return colors.orange;
  return colors.red;
}

// Flat orange keeps several scoped bars readable as one group; >=90 red flags a nearly-spent cap.
function getScopedColor(percentage) {
  return percentage >= 90 ? colors.red : colors.orange;
}

// Drop the context-window suffix: "Opus 5.5 (1M context)" -> "Opus 5.5".
function shortenModel(name) {
  return name.replace(/\s*\([^)]*context\)/i, '');
}

// Resolved model ID -> "Opus 5" / "Haiku 4.5" (strips prefixes + trailing -YYYYMMDD).
function shortenModelId(id) {
  if (!id) return '';
  const stripped = String(id).replace(/^(us\.)?(anthropic\.)?claude-/, '').replace(/-\d{8}$/, '');
  const [family, ...rest] = stripped.split('-');
  if (!family) return stripped;
  const name = family[0].toUpperCase() + family.slice(1);
  const version = rest.join('.');
  return version ? `${name} ${version}` : name;
}

// Tail-truncate an over-long branch name, preserving the leading ticket ID.
function truncateBranch(name) {
  return name.length > MAX_BRANCH_LEN ? name.slice(0, MAX_BRANCH_LEN - 1) + '…' : name;
}

// Walks up from `dir` to the git dir (no subprocess); handles worktrees (".git" file). '' on failure.
function resolveGitDir(dir) {
  let cur = dir;
  let gitPath = '';
  for (let i = 0; i < 50 && cur; i++) {
    const candidate = path.join(cur, '.git');
    if (fs.existsSync(candidate)) { gitPath = candidate; break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;          // reached filesystem root
    cur = parent;
  }
  if (!gitPath) return '';

  if (fs.statSync(gitPath).isFile()) {
    // ".git" is a file like "gitdir: /path/to/.git/worktrees/x".
    const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
    if (!m) return '';
    return path.resolve(path.dirname(gitPath), m[1].trim());
  }
  return gitPath;
}

// Branch read straight from .git/HEAD (no subprocess); detached HEAD -> short sha; '' on failure.
function getGitBranch(dir) {
  try {
    const gitDir = resolveGitDir(dir);
    if (!gitDir) return '';
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    // HEAD is read raw, not git-validated: strip control chars (escape-sequence injection).
    if (ref) return truncateBranch(ref[1].replace(/[\x00-\x1f\x7f]/g, ''));
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);  // detached HEAD -> short sha
    return '';
  } catch (e) {
    return '';
  }
}

// Cached ahead/behind for gitDir; different repo invalidates. { age, ahead, behind } or null.
function readGitCache(gitDir) {
  try {
    const c = JSON.parse(fs.readFileSync(GIT_CACHE_FILE, 'utf8'));
    if (!c || c.gitDir !== gitDir || !Number.isFinite(c.timestamp)) return null;
    if (!Number.isFinite(c.ahead) || !Number.isFinite(c.behind)) return null;
    return { age: Date.now() - c.timestamp, ahead: c.ahead, behind: c.behind };
  } catch (e) {
    return null;
  }
}

function writeGitCache(gitDir, ahead, behind) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(GIT_CACHE_FILE, JSON.stringify({ gitDir, timestamp: Date.now(), ahead, behind }), 'utf8');
  } catch (e) {}
}

// The only `git` subprocess, cache-fronted. null on no upstream/detached/failed (segment omitted);
// slow/failed call falls back to last counts up to GIT_STALE_TTL_MS so counts don't flicker.
function getGitAheadBehind(dir) {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return null;

  const cached = readGitCache(gitDir);
  if (cached && cached.age < GIT_FRESH_TTL_MS) {
    return { ahead: cached.ahead, behind: cached.behind };
  }

  try {
    // No shell (faster cold spawn, @{u} literal); --left-right --count prints "<behind>\t<ahead>".
    const out = execFileSync('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const parts = out.split(/\s+/);
    const behind = parseInt(parts[0], 10);
    const ahead = parseInt(parts[1], 10);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) {
      writeGitCache(gitDir, ahead, behind);
      return { ahead, behind };
    }
    return null;
  } catch (e) {
    if (cached && cached.age < GIT_STALE_TTL_MS) {
      return { ahead: cached.ahead, behind: cached.behind };
    }
    return null;
  }
}

// "↑N↓M": ahead green, behind red, zero side omitted; '' when in sync or null.
function formatAheadBehind(ab) {
  if (!ab) return '';
  let s = '';
  if (ab.ahead) s += `${colors.green}↑${ab.ahead}${colors.reset}`;
  if (ab.behind) s += `${colors.red}↓${ab.behind}${colors.reset}`;
  return s;
}

// Colored "C<used> <bar>" (e.g. "C45 ⠿⠿⠟" then a gray "⠿⠿⠿"); shared by main line and subagent rows.
function renderContextBar(used) {
  const dots = Math.round((Math.max(0, Math.min(100, used)) / 100) * BAR_WIDTH * BAR_DOTS);
  const lit = Math.ceil(dots / BAR_DOTS);
  let bar = '';
  for (let i = 0; i < lit; i++) bar += BAR_CELLS[Math.min(BAR_DOTS, dots - i * BAR_DOTS)];
  const track = lit < BAR_WIDTH ? `${colors.gray}${BAR_CELLS[BAR_DOTS].repeat(BAR_WIDTH - lit)}${colors.reset}` : '';

  let color;
  if (used < 50) color = colors.green;
  else if (used < 65) color = colors.yellow;
  else if (used < 80) color = colors.orange;
  else color = colors.red;

  return `${color}C${used} ${bar}${colors.reset}${track}`;
}

function getContextBar(remaining) {
  const effectiveRemaining = remaining ?? 100;
  const used = Math.max(0, Math.min(100, 100 - Math.round(effectiveRemaining)));
  return renderContextBar(used);
}

// "model" or "model · effort" (colored). Shared by the main line and subagent rows.
function renderModelEffort(model, effort) {
  return effort ? `${model}${getEffortColor(effort)} · ${effort}${colors.reset}` : model;
}

// "<label><pct> ↺ <countdown>" (e.g. "H81 ↺ 2h21m"), no bar. Called on every read so the
// countdown recomputes from resetsAt; `color` overrides the thresholds (scoped bars).
function buildUsageBar(label, percentage, resetsAt, color) {
  let timeStr = '';
  if (resetsAt) {
    const diffMins = Math.max(0, Math.floor((new Date(resetsAt) - new Date()) / 60000));
    const days = Math.floor(diffMins / 1440);
    const hours = Math.floor((diffMins % 1440) / 60);
    const mins = diffMins % 60;
    if (days > 0) timeStr = `${days}d${hours}h`;
    else if (hours > 0) timeStr = `${hours}h${mins}m`;
    else timeStr = `${mins}m`;
  }

  const barColor = color || getUsageColor(percentage);
  const timePart = timeStr ? `${colors.dim} ↺ ${timeStr}${colors.reset}` : '';

  return `${barColor}${label}${percentage}${colors.reset}${timePart}`;
}

// Model-scoped weekly limits, rendered after W. /usage payload `limits[]` entries:
//   { kind: "weekly_scoped", percent, resets_at, scope: { model: { display_name } } }
// Label = first initial of the model name (Fable -> F). Legacy flat seven_day_<model> keys
// kept as fallback. Only ever in the API payload — stdin rate_limits never carries them.
const LEGACY_MODEL_WEEKLY_KEYS = [
  { key: 'seven_day_opus', label: 'O' },
  { key: 'seven_day_sonnet', label: 'S' }
];

// Raw { fiveHour, weekly, models } -> rendered segments; scoped bars use getScopedColor.
function buildUsageBars(raw) {
  const { fiveHour, weekly, models } = raw || {};
  return {
    current: fiveHour ? buildUsageBar('H', fiveHour.percentage, fiveHour.resetsAt) : null,
    weekly: weekly ? buildUsageBar('W', weekly.percentage, weekly.resetsAt) : null,
    models: (models || []).map(m => buildUsageBar(m.label, m.percentage, m.resetsAt, getScopedColor(m.percentage)))
  };
}

// Clamp to 0-100 int; null on non-finite so callers omit the bar instead of rendering "NaN%".
function normalizePercentage(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// limits[] -> [{ label, percentage, resetsAt }]; legacy flat keys only when limits yields nothing.
function parseScopedLimits(usage) {
  const scoped = [];

  if (Array.isArray(usage?.limits)) {
    for (const entry of usage.limits) {
      if (!entry || entry.kind !== 'weekly_scoped') continue;
      const name = entry.scope?.model?.display_name;
      const pct = normalizePercentage(entry.percent);
      if (typeof name !== 'string' || !name.trim() || pct == null) continue;
      scoped.push({
        label: name.trim().charAt(0).toUpperCase(),
        percentage: pct,
        resetsAt: entry.resets_at || null
      });
    }
    if (scoped.length) return scoped;
  }

  for (const { key, label } of LEGACY_MODEL_WEEKLY_KEYS) {
    const seg = usage?.[key];
    const pct = seg ? normalizePercentage(seg.utilization) : null;
    if (pct != null) scoped.push({ label, percentage: pct, resetsAt: seg.resets_at || null });
  }
  return scoped;
}

// Usage from stdin `rate_limits` (Pro/Max only, absent at cold start) — skips the
// network/cache path entirely. resets_at is Unix epoch SECONDS (not ISO). Same raw shape as
// parseUsagePayload; models always [] — scoped limits never arrive via stdin.
function buildUsageFromStdin(data) {
  const rl = data?.rate_limits;
  if (!rl) return null;

  const toEntry = (seg) => {
    if (!seg) return null;
    const pct = normalizePercentage(seg.used_percentage);
    if (pct == null) return null;
    // Defensive: this path runs outside outputStatus's try/catch — bad value -> null, never a throw.
    let resetsAt = null;
    const epoch = Number(seg.resets_at);
    if (Number.isFinite(epoch) && epoch > 0) {
      const d = new Date(epoch * 1000);
      if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString();
    }
    return { percentage: pct, resetsAt };
  };

  const fiveHour = toEntry(rl.five_hour);
  if (!fiveHour) return null;          // five_hour is the required bar
  return { fiveHour, weekly: toEntry(rl.seven_day), models: [] };
}

// /usage response body -> { fiveHour, weekly, models }, or null on unparseable JSON or a
// missing/non-finite five_hour utilization (that bar is required). Pure, so unit-testable
// directly — unlike getApiUsage, which needs a live socket.
function parseUsagePayload(body) {
  try {
    const usage = JSON.parse(body);
    const fivePct = usage?.five_hour ? normalizePercentage(usage.five_hour.utilization) : null;
    if (fivePct == null) return null;

    const fiveHour = { percentage: fivePct, resetsAt: usage.five_hour.resets_at || null };
    const weeklyPct = usage.seven_day ? normalizePercentage(usage.seven_day.utilization) : null;
    const weekly = weeklyPct != null ? { percentage: weeklyPct, resetsAt: usage.seven_day.resets_at || null } : null;
    const models = parseScopedLimits(usage);

    return { fiveHour, weekly, models };
  } catch (e) {
    return null;
  }
}

// Valid entry: finite 0-100 percentage, parseable (or absent) resetsAt.
function isValidUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!Number.isFinite(entry.percentage) || entry.percentage < 0 || entry.percentage > 100) return false;
  if (entry.resetsAt != null && Number.isNaN(new Date(entry.resetsAt).getTime())) return false;
  return true;
}

// Cached usage -> { age, data } or null; caller applies TTLs. Invalid shape -> null.
function readCachedUsage() {
  try {
    if (!fs.existsSync(USAGE_CACHE_FILE)) return null;

    const cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    if (!cache || !Number.isFinite(cache.timestamp) || cache.timestamp <= 0) return null;

    // fiveHour required; weekly/models optional. Rejects legacy formats lacking fiveHour.
    const data = cache.data;
    if (!data || typeof data !== 'object') return null;
    if (!isValidUsageEntry(data.fiveHour)) return null;
    if (data.weekly != null && !isValidUsageEntry(data.weekly)) return null;
    if (data.models != null) {
      if (!Array.isArray(data.models)) return null;
      if (!data.models.every(m => typeof m?.label === 'string' && isValidUsageEntry(m))) return null;
    }

    return { age: Date.now() - cache.timestamp, data };
  } catch (e) {
    return null;
  }
}

// On-disk cache shape; pure so test/preview seeds produce writer-identical bytes. lastAttempt
// starts equal to timestamp: a successful write is itself an attempt.
function serializeUsageCache(data, timestamp = Date.now()) {
  return JSON.stringify({ timestamp, data, lastAttempt: timestamp });
}

// Write usage data to cache (shared across all sessions)
function setCachedUsage(data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(USAGE_CACHE_FILE, serializeUsageCache(data), 'utf8');
  } catch (e) {
    // Silently fail
  }
}

// Age in ms since the last attempt (success or failure), or null. Read from the raw file, not
// readCachedUsage, so the cooldown applies even when no valid data has ever been cached.
function getLastAttemptAge() {
  try {
    if (!fs.existsSync(USAGE_CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    if (!cache || !Number.isFinite(cache.lastAttempt) || cache.lastAttempt <= 0) return null;
    return Date.now() - cache.lastAttempt;
  } catch (e) {
    return null;
  }
}

// Stamp lastAttempt before the request so failed attempts still enter cooldown; preserves
// existing cached data so a failed refresh doesn't erase the last successful one.
function recordUsageAttempt() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    } catch (e) {}
    const merged = existing && typeof existing === 'object' ? { ...existing } : {};
    merged.lastAttempt = Date.now();
    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(merged), 'utf8');
  } catch (e) {
    // Silently fail
  }
}

// Strict "x.y.z" -> -1|0|1, null otherwise (prerelease never nudges — a nicety, not a guess).
function compareVersions(a, b) {
  const parse = (v) => SEMVER_RE.test(String(v ?? '')) ? String(v).split('.').map(Number) : null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

// Registry body -> "x.y.z" or null (404 bodies land here too).
function parseRegistryVersion(body) {
  try {
    const v = JSON.parse(body)?.version;
    return SEMVER_RE.test(String(v ?? '')) ? String(v) : null;
  } catch (e) {
    return null;
  }
}

function readUpdateCache() {
  try {
    const c = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch (e) {
    return null;
  }
}

function writeUpdateCache(obj) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {}
}

// Render-path read of the update cache: { update: newer cached latest or '', updated: {from, to}
// or null }. A self-install that produced this VERSION wins; its row lives UPDATED_NOTICE_MS
// from the first render that shows it, stamped here. Render never touches the network.
function getUpdateFacts() {
  const cached = readUpdateCache();
  if (!cached) return { update: '', updated: null };
  if (cached.updatedTo === VERSION && SEMVER_RE.test(String(cached.updatedFrom ?? ''))) {
    const now = Date.now();
    let shownAt = cached.updatedShownAt;
    if (!Number.isFinite(shownAt)) {
      shownAt = now;
      writeUpdateCache({ ...cached, updatedShownAt: now });
    }
    if (now - shownAt < UPDATED_NOTICE_MS) {
      return { update: '', updated: { from: cached.updatedFrom, to: VERSION } };
    }
  }
  const update = compareVersions(cached.latest, VERSION) === 1 ? String(cached.latest) : '';
  return { update, updated: null };
}

// Spawn the check in a detached child — the render never waits on the registry. lastAttempt is
// stamped before the spawn, so an offline/failed/killed child backs off UPDATE_RETRY_MS.
function refreshUpdateCheck() {
  try {
    const cached = readUpdateCache();
    const now = Date.now();
    if (cached) {
      if (Number.isFinite(cached.checkedAt) && now - cached.checkedAt < UPDATE_TTL_MS) return;
      if (Number.isFinite(cached.lastAttempt) && now - cached.lastAttempt < UPDATE_RETRY_MS) return;
    }
    writeUpdateCache({ ...(cached || {}), lastAttempt: now });
    // windowsHide: no console flash on Windows; detached + unref: child outlives the render's exit.
    spawn(process.execPath, [__filename, 'update-check'], {
      detached: true, stdio: 'ignore', windowsHide: true
    }).unref();
  } catch (e) {}
}

// GET -> cb(body) on HTTP 200, cb(null) otherwise; cb fires exactly once.
function httpsGet(hostname, urlPath, cb) {
  let settled = false;
  let deadline;
  let req;

  const done = (body) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (body === null && req) req.destroy();
    cb(body);
  };

  try {
    req = https.request({ hostname, path: urlPath, method: 'GET', timeout: UPDATE_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => done(body));
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.on('timeout', () => done(null));
    // The timeout option is socket inactivity, not total — a trickling response needs this hard deadline.
    deadline = setTimeout(() => done(null), UPDATE_TIMEOUT_MS);
    req.end();
  } catch (e) {
    done(null);
  }
}

// Downloaded statusline.js -> true only when it declares exactly `version`.
function isReleaseBody(body, version) {
  const match = typeof body === 'string' ? body.match(/^const VERSION = '([^']+)';\r?$/m) : null;
  return !!match && match[1] === version;
}

function isInstalledHook() {
  const self = path.resolve(__filename);
  const hook = path.resolve(HOOK_FILE);
  return process.platform === 'win32' ? self.toLowerCase() === hook.toLowerCase() : self === hook;
}

// Temp file + rename: a concurrent render reads the old file or the new one, never a mix.
function installRelease(body) {
  const tmp = `${__filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, __filename);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
}

// Detached 'update-check' entry point: fetch latest, self-install when allowed, stamp cache, exit.
// A failed fetch or install leaves checkedAt untouched, so the UPDATE_RETRY_MS backoff (not
// UPDATE_TTL_MS) governs the next try; a failed install still caches latest for the nudge row.
function runUpdateCheck() {
  httpsGet(REGISTRY_HOST, `/${PACKAGE_NAME}/latest`, (registryBody) => {
    const latest = parseRegistryVersion(registryBody);
    if (!latest) return process.exit(0);

    const stamp = (extra) => {
      writeUpdateCache({ ...(readUpdateCache() || {}), latest, ...extra });
      process.exit(0);
    };

    if (compareVersions(latest, VERSION) !== 1 || DISABLED.has('autoupdate') || !isInstalledHook()) {
      return stamp({ checkedAt: Date.now() });
    }
    httpsGet(RELEASE_HOST, `/${RELEASE_REPO}/v${latest}/statusline.js`, (body) => {
      const installed = isReleaseBody(body, latest) && installRelease(body);
      stamp(installed
        ? { checkedAt: Date.now(), updatedFrom: VERSION, updatedTo: latest, updatedShownAt: null }
        : {});
    });
  });
}

function getCredentials() {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credsPath)) {
    try {
      return JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch (e) {}
  }

  // macOS keychain fallback
  if (os.platform() === 'darwin') {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', { encoding: 'utf8', timeout: 1000 });
      return JSON.parse(raw.trim());
    } catch (e) {}
  }

  return null;
}

function getApiUsage(callback) {
  try {
    const creds = getCredentials();
    if (!creds) {
      return callback(null);
    }

    const accessToken = creds.claudeAiOauth?.accessToken;

    if (!accessToken) {
      return callback(null);
    }

    // Tighter timeout when the cache is warm — a fresh render already has data to print.
    const hasCache = fs.existsSync(USAGE_CACHE_FILE);
    const timeout = hasCache ? 1200 : 1500;

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      timeout: timeout
    }, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const resolved = parseUsagePayload(data);
        if (resolved) setCachedUsage(resolved);
        callback(resolved);
      });
    });

    req.on('error', () => callback(null));
    req.on('timeout', () => {
      req.destroy();
      callback(null);
    });

    req.end();
  } catch (e) {
    callback(null);
  }
}

// Resolve raw usage data ({ fiveHour, weekly, models }), cache-first. Callers render it.
function getRawUsage(callback) {
  const cached = readCachedUsage();

  if (cached && cached.age < FRESH_TTL_MS) {
    return callback(cached.data);
  }

  // Refresh attempted (even failed) within FRESH_TTL_MS -> cooldown: serve stale up to STALE_TTL_MS (issue #41).
  const attemptAge = getLastAttemptAge();
  if (attemptAge != null && attemptAge < FRESH_TTL_MS) {
    return callback(cached && cached.age < STALE_TTL_MS ? cached.data : null);
  }

  recordUsageAttempt();
  getApiUsage((fresh) => {
    if (fresh) {
      callback(fresh);
    } else if (cached && cached.age < STALE_TTL_MS) {
      callback(cached.data);
    } else {
      callback(null);
    }
  });
}

// "$0.00" (dim) from stdin cost.total_cost_usd — client-side estimate, no network; '' when absent.
function getCostSegment(data) {
  const usd = data?.cost?.total_cost_usd;
  if (!Number.isFinite(usd)) return '';
  return `${colors.dim}${formatUsd(usd)}${colors.reset}`;
}

function getCurrentTask(sessionId) {
  if (!sessionId) return '';

  const homeDir = os.homedir();
  const todosDir = path.join(homeDir, '.claude', 'todos');

  if (!fs.existsSync(todosDir)) return '';

  try {
    const files = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(sessionId) && f.includes('-agent-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
      const inProgress = todos.find(t => t.status === 'in_progress');
      if (inProgress) return inProgress.activeForm || '';
    }
  } catch (e) {}

  return '';
}

// A transcript's state file: ~/.claude/cache/tokens/<sha1 of its path>.json.
function costCacheFile(file) {
  return path.join(COST_CACHE_DIR, crypto.createHash('sha1').update(file).digest('hex') + '.json');
}

// Delete state files (and stray temp files) not written for COST_MAX_AGE_MS. Best-effort: a
// file another render is writing, or one already gone, is skipped.
function pruneCostStates(now = Date.now()) {
  try {
    for (const name of fs.readdirSync(COST_CACHE_DIR)) {
      const file = path.join(COST_CACHE_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > COST_MAX_AGE_MS) fs.unlinkSync(file);
      } catch (e) {}
    }
  } catch (e) {}
}

// Canonical catalog id of a model as transcripts and stdin name it: "claude-opus-5[1m]",
// "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-opus-4-20250514" -> "claude-opus-4-0".
function canonicalModel(id) {
  const s = String(id || '').toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^((us|eu|apac|global|jp|au)\.)?(anthropic\.)?/, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/[@-]\d{8}$/, '');
  return MODEL_PRICES[s] || !MODEL_PRICES[`${s}-0`] ? s : `${s}-0`;
}

// Dollars one API reply cost, as Claude Code prices it: the model's tier (fast-mode tier when
// usage.speed is "fast"), Haiku 5.5's long-prompt rates past 100k prompt tokens, 1h cache
// writes at their own rate, ×1.1 for US-only inference, and $0.01 per web search.
function usageCost(model, usage) {
  if (!usage) return 0;
  const id = canonicalModel(model);
  const fast = usage.speed === 'fast';
  let p = (fast && FAST_PRICES[id]) || MODEL_PRICES[id] || DEFAULT_PRICE;
  const input = usage.input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  if (p.long && input + read + write > p.long.above) p = p.long;
  const write1h = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens || 0, write);
  const usd = (input * p.in + output * p.out + (write - write1h) * p.w5m + write1h * p.w1h + read * p.read) / 1e6;
  return usd * (usage.inference_geo === 'us' ? 1.1 : 1) + (usage.server_tool_use?.web_search_requests || 0) * 0.01;
}

// Transcripts log a reply's usage as its stream starts: input and cache counts are final, but
// output_tokens is only what was out by then (often under 20). What the reply wrote is in its
// records, one content block each, so its output is at least that text, at ~4 characters a
// token: text, tool inputs and thinking text (thinking the model kept hidden adds more, which
// no transcript shows).
const CHARS_PER_TOKEN = 4;

function contentChars(content) {
  let n = 0;
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'text' && typeof c.text === 'string') n += c.text.length;
    else if (c?.type === 'thinking' && typeof c.thinking === 'string') n += c.thinking.length;
    else if (c?.type === 'tool_use' && c.input != null) n += JSON.stringify(c.input).length;
  }
  return n;
}

// One transcript line into the running state: assistant records only. A reply is logged once
// per content block under one message id, so its cost is priced again as each record adds to
// it (recent: [id, usd, chars, logged output]), replacing the cost counted before.
function addCostLine(state, line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let d;
  try {
    d = JSON.parse(line);
  } catch (e) {
    return;
  }
  const usage = d?.message?.usage;
  if (d.type !== 'assistant' || !usage) return;
  const id = d.message.id || d.requestId || d.uuid;
  let seen = state.recent.find(r => r[0] === id);
  if (!seen) {
    seen = [id, 0, 0, 0];
    state.recent.push(seen);
    if (state.recent.length > COST_RECENT_IDS) state.recent.shift();
  }
  seen[2] += contentChars(d.message.content);
  seen[3] = Math.max(seen[3], usage.output_tokens || 0);
  const output = Math.max(seen[3], Math.ceil(seen[2] / CHARS_PER_TOKEN));
  const now = usageCost(d.message.model, { ...usage, output_tokens: output });
  if (!Number.isFinite(now)) return;
  state.usd += now - seen[1];
  seen[1] = now;
}

// { usd, partial } for one subagent transcript, or null. Reads only what was appended since
// the last render; partial while a long transcript is still being caught up on.
function readAgentCost(file) {
  if (typeof file !== 'string' || !file) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    const cacheFile = costCacheFile(file);
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
    // A replaced or truncated transcript, or a state file from an older format, starts over.
    if (!state || state.v !== COST_STATE_VERSION || state.ino !== stat.ino || !(state.offset <= stat.size)
      || !Number.isFinite(state.usd) || !Array.isArray(state.recent)) {
      state = { v: COST_STATE_VERSION, ino: stat.ino, offset: 0, usd: 0, recent: [] };
    }
    if (state.offset < stat.size) {
      fd = fs.openSync(file, 'r');
      const length = Math.min(stat.size - state.offset, COST_MAX_READ);
      const buf = Buffer.alloc(length);
      const got = fs.readSync(fd, buf, 0, length, state.offset);
      // Whole lines only: the agent may be mid-write on the last one.
      const end = got > 0 ? buf.lastIndexOf(10, got - 1) : -1;
      if (end >= 0) {
        for (const line of buf.toString('utf8', 0, end).split('\n')) addCostLine(state, line);
        state.offset += end + 1;
        fs.mkdirSync(COST_CACHE_DIR, { recursive: true });
        const isNew = !fs.existsSync(cacheFile);
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, cacheFile);
        if (isNew) pruneCostStates();
      }
    }
    return { usd: Math.max(0, state.usd), partial: stat.size - state.offset > COST_MAX_READ / 64 };
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) {}
    }
  }
}

// A subagent row's transcript: agent-<task id>.jsonl beside the session's transcript, else the
// most recent subagent whose .meta.json has the task's description; '' when none.
function subagentTranscript(transcriptPath, task) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || !task) return '';
  try {
    const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    const direct = path.join(dir, `agent-${task.id}.jsonl`);
    if (fs.existsSync(direct)) return direct;
    if (!task.description) return '';
    let best = '';
    let bestTime = -1;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (meta?.description !== task.description) continue;
        const file = path.join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
        const time = fs.statSync(file).mtimeMs;
        if (time > bestTime) {
          best = file;
          bestTime = time;
        }
      } catch (e) {}
    }
    return best;
  } catch (e) {
    return '';
  }
}

// 0.4213 -> "$0.42", 1318.394 -> "$1318.39". Shared by the main line's cost and subagent rows.
function formatUsd(usd) {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

// A subagent's "$0.42" (dim), with "…" while its transcript is still being caught up on; ''
// when absent or nothing spent yet.
function renderAgentCost(cost) {
  if (!cost || !(cost.usd > 0)) return '';
  return `${colors.dim}${formatUsd(cost.usd)}${cost.partial ? '…' : ''}${colors.reset}`;
}

// Visible (printable) width of a segment string: strip ANSI color codes, count code points.
function visibleWidth(str) {
  return [...str.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

// Two lines only when cols is known (COLUMNS, set by Claude Code v2.1.153+) and the single
// line overflows; unknown width or empty line2 stays single. cols is a parameter — no env read.
function layout(line1Parts, line2Parts, cols) {
  const single = [...line1Parts, ...line2Parts].join(SEGMENT_SEP);
  if (line2Parts.length === 0) return single;
  if (Number.isFinite(cols) && cols > 0 && visibleWidth(single) > cols - WIDTH_MARGIN) {
    return line1Parts.join(SEGMENT_SEP) + '\n' + line2Parts.join(SEGMENT_SEP);
  }
  return single;
}

// Everything the render needs that touches fs/child_process/env (git, todos, update cache,
// COLUMNS), so renderStatusLine stays pure. Own try/catch: called outside outputStatus's, and a
// malformed current_dir must still degrade to a renderable fallback.
function collectFacts(data) {
  try {
    const dir = data?.workspace?.current_dir || process.cwd();
    const dirname = path.basename(dir);
    const branch = DISABLED.has('branch') ? '' : getGitBranch(dir);
    const sync = branch ? formatAheadBehind(getGitAheadBehind(dir)) : '';
    const sessionId = data?.session_id || '';
    const task = DISABLED.has('task') ? '' : getCurrentTask(sessionId);
    const { update, updated } = DISABLED.has('update') ? { update: '', updated: null } : getUpdateFacts();
    const cols = parseInt(process.env.COLUMNS, 10);
    return { dirname, branch, sync, task, update, updated, cols };
  } catch (e) {
    return { dirname: '~', branch: '', sync: '', task: '', update: '', updated: null, cols: undefined };
  }
}

// Own stdout row, not a segment: the copy-pasteable command is too wide to inline without
// forcing a wrap. Appended after layout() so it never joins the wrap decision.
function renderUpdateLine(latest) {
  return `${colors.green}⬆ ${latest}${colors.reset} `
    + `${colors.dim}available ·${colors.reset} `
    + `${colors.bold}npx ${PACKAGE_NAME}@latest${colors.reset}`;
}

function renderUpdatedLine({ from, to }) {
  return `${colors.green}⬆ ctxline updated${colors.reset} `
    + `${colors.dim}${from} →${colors.reset} `
    + `${colors.bold}${to}${colors.reset}`;
}

// Pure: data + facts (see collectFacts) + usage bars -> rendered line(s); callable directly in tests.
function renderStatusLine(data, facts, usage) {
  const model = shortenModel(data?.model?.display_name || 'Claude');
  const effort = DISABLED.has('effort') ? '' : (data?.effort?.level || '');
  const remaining = data?.context_window?.remaining_percentage;

  const contextBar = getContextBar(remaining);
  const cost = DISABLED.has('cost') ? '' : getCostSegment(data);

  // line1 = identity + context (always); line2 = usage/cost/task (wrap target).
  const line1 = [];
  line1.push(facts.branch
    ? `${facts.dirname} ${colors.dim}⎇ ${facts.branch}${colors.reset}${facts.sync ? ' ' + facts.sync : ''}`
    : facts.dirname);
  line1.push(renderModelEffort(model, effort));
  line1.push(contextBar);

  const line2 = [];
  if (usage?.current) line2.push(usage.current);
  if (usage?.weekly) line2.push(usage.weekly);
  if (usage?.models?.length) line2.push(...usage.models);
  if (cost) line2.push(cost);
  if (facts.task) line2.push(`${colors.dim}${facts.task}${colors.reset}`);

  const body = layout(line1, line2, facts.cols);
  if (facts.updated) return body + '\n' + renderUpdatedLine(facts.updated);
  return facts.update ? body + '\n' + renderUpdateLine(facts.update) : body;
}

function outputStatus(data, facts, usage) {
  try {
    process.stdout.write(renderStatusLine(data, facts, usage));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usage) {
  const facts = { dirname: '~', branch: '', sync: '', task: '', update: '', updated: null, cols: undefined };
  process.stdout.write(renderStatusLine(null, facts, usage));
}

// Usage bars: API-key users none; prefer stdin rate_limits, else cache+API (cold start / non-Pro/Max).
function resolveUsage(data, callback) {
  if (IS_API_KEY || DISABLED.has('usage')) {
    return callback(null);
  }
  const fromStdin = buildUsageFromStdin(data);
  if (fromStdin) {
    // Scoped limits only exist in the API payload -> fetch from cache; a failed/slow call
    // costs only those bars, never the H/W bars stdin already gave us.
    return getRawUsage((cached) => {
      callback(buildUsageBars({ ...fromStdin, models: cached?.models || [] }));
    });
  }
  getRawUsage((raw) => callback(raw ? buildUsageBars(raw) : null));
}

// Parse the accumulated stdin into a payload object, or null if empty/unparseable.
function parseInput(input) {
  if (!input || input.length === 0) return null;
  try {
    return JSON.parse(input);
  } catch (e) {
    return null;
  }
}

// Accumulate stdin, call fn(input) exactly once — timeout, 'end', or 'error' whichever fires
// first (the error handler preserves the never-throw contract). Shared by both entry points.
function readStdinThen(timeoutMs, fn) {
  let input = '';
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    fn(input);
  };

  const timeout = setTimeout(finish, timeoutMs);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

// Resolve usage for `data` (preferring stdin rate_limits), then render and exit.
function emit(data) {
  if (!DISABLED.has('update')) refreshUpdateCheck();
  resolveUsage(data, (usage) => {
    if (data) {
      outputStatus(data, collectFacts(data), usage);
    } else {
      outputFallback(usage);
    }
    process.exit(0);
  });
}

// "45s" / "4m12s" / "2h5m". startTime's format is undocumented upstream, so accept epoch-seconds
// (< 1e12), epoch-ms, or an ISO string. Revisit if a real payload contradicts.
function formatElapsed(startTime) {
  if (startTime == null) return '';
  const ms = typeof startTime === 'number' && startTime < 1e12 ? startTime * 1000 : startTime;
  const start = new Date(ms).getTime();
  if (Number.isNaN(start)) return '';

  const diffSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  if (hours > 0) return `${hours}h${mins}m`;
  if (mins > 0) return `${mins}m${secs}s`;
  return `${secs}s`;
}

// "#5bb8f5" -> the 24-bit foreground escape for it.
function hexToAnsi(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

// Stable palette color for an agent missing from the registry: FNV-1a of its name.
function agentHashColor(name) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(name), 'utf8')) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

// The registry `agent-color` writes; {} when missing or unreadable. Read-only.
function readAgentColors() {
  try {
    const data = JSON.parse(fs.readFileSync(AGENT_COLORS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

// An agent's color: its registry entry when well-formed, else its hash color.
function agentColorOf(registry, name) {
  const color = registry?.[name]?.color;
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : agentHashColor(name);
}

// Plain text cut to `width` cells, ending in "…" when cut.
function truncateText(text, width) {
  const chars = [...text];
  if (chars.length <= width) return text;
  return chars.slice(0, Math.max(0, width - 1)).join('') + '…';
}

// One subagentStatusLine row:
// "name │ activity │ Model · effort │ C<used> <bar> │ ⏱ <elapsed> │ $<cost>".
// name is the description the agent was spawned with ("Reply colors plugin"), bold in its color
// (`opts.color`, from the registry; else its hash color). activity is the task's live `label`,
// dim, cut with "…" so the row fits `opts.cols` (the terminal width) less the panel's indent, or
// to ACTIVITY_MAX when the width is unknown; no label, or no room, drops it. Every segment past
// name is conditional on its source being present/finite. `cost` is the subagent's
// readAgentCost(), read by emitSubagent; absent -> no cost segment.
function renderSubagentTask(t, cost, opts = {}) {
  const name = String(t.description || t.name || 'agent');
  const color = opts.color || agentHashColor(name);
  const head = `${colors.bold}${hexToAnsi(color)}${name}${colors.reset}`;
  const parts = [];

  const model = shortenModelId(t.model);
  // effort absent = subagent inherits the session effort; show model alone then.
  const effort = t.effort != null ? String(t.effort) : '';
  if (model) {
    parts.push(renderModelEffort(model, effort));
  } else if (effort) {
    parts.push(`${getEffortColor(effort)}${effort}${colors.reset}`);
  }

  if (Number.isFinite(t.tokenCount) && Number.isFinite(t.contextWindowSize) && t.contextWindowSize > 0) {
    const used = Math.max(0, Math.min(100, Math.round((t.tokenCount / t.contextWindowSize) * 100)));
    parts.push(renderContextBar(used));
  }

  const elapsed = formatElapsed(t.startTime);
  if (elapsed) parts.push(`${colors.dim}⏱ ${elapsed}${colors.reset}`);

  const costSegment = renderAgentCost(cost);
  if (costSegment) parts.push(costSegment);

  const activity = typeof t.label === 'string' ? t.label.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim() : '';
  if (activity) {
    const cols = opts.cols;
    const room = Number.isFinite(cols) && cols > 0
      ? cols - SUBAGENT_ROW_INDENT - WIDTH_MARGIN - visibleWidth([head, '', ...parts].join(SEGMENT_SEP))
      : ACTIVITY_MAX;
    // Below a few cells the cut text says nothing: leave the segment out.
    if (room >= Math.min(4, [...activity].length)) {
      parts.unshift(`${colors.dim}${truncateText(activity, room)}${colors.reset}`);
    }
  }

  return [head, ...parts].join(SEGMENT_SEP);
}

// subagentStatusLine mode: one {id, content} JSON line per task. No usage/git/todos work; the
// one file read is each subagent's transcript for its cost (skipped with CTXLINE_DISABLE=cost).
// Bad payload or a task that fails to render -> emit nothing (default rendering stays).
function emitSubagent(data) {
  try {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const costOf = t => (DISABLED.has('cost') ? null : readAgentCost(subagentTranscript(data?.transcript_path, t)));
    const registry = readAgentColors();
    const cols = parseInt(process.env.COLUMNS, 10);
    const optsOf = t => ({ color: agentColorOf(registry, String(t.description || t.name || 'agent')), cols });
    const out = tasks
      .filter(t => t && t.id)
      .map(t => JSON.stringify({ id: t.id, content: renderSubagentTask(t, costOf(t), optsOf(t)) }))
      .join('\n');
    if (out) {
      // Exit from the write callback: process.exit() would drop output queued behind backpressure.
      process.stdout.write(out + '\n', () => process.exit(0));
      return;
    }
  } catch (e) {}
  process.exit(0);
}

// Guarded so tests can require() the exports instead of spawning the script.
if (require.main === module) {
  const mode = process.argv[2];
  const isSubagent = mode === 'subagent';
  const finish = isSubagent ? emitSubagent : emit;

  if (mode === 'update-check') {
    runUpdateCheck();
  } else if (process.stdin.isTTY) {
    finish(null);
  } else {
    const timeoutMs = isSubagent
      ? SUBAGENT_TIMEOUT_MS
      : (IS_API_KEY ? 500 : (fs.existsSync(USAGE_CACHE_FILE) ? 1300 : 1600));
    readStdinThen(timeoutMs, (input) => finish(parseInput(input)));
  }
} else {
  module.exports = { parseScopedLimits, parseUsagePayload, serializeUsageCache, normalizePercentage, readStdinThen, renderStatusLine, renderSubagentTask, renderContextBar, agentHashColor, agentColorOf, AGENT_PALETTE, formatUsd, usageCost, addCostLine, compareVersions, parseRegistryVersion, isReleaseBody, VERSION };
}
