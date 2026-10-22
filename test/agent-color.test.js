// Agent colors: the `agent-color` CLI that assigns each subagent a palette color in
// ~/.claude/agent-colors.json, and the subagent row that draws the name in it (registry color,
// else a stable hash) with the live activity between name and model, cut to the terminal width.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeHome, spawnSubagent } = require('./fixture');
const { PALETTE, assignColor, KEEP_MS, RECENT_MS } = require('../agent-color.js');
const { renderSubagentTask, agentHashColor, agentColorOf, AGENT_PALETTE } = require('../statusline.js');

const CLI = path.join(__dirname, '..', 'agent-color.js');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const at = (ms) => new Date(ms).toISOString();
const ansiOf = (hex) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;

// ── palette ──

const ORCHESTRATOR_BLUE = '#5bb8f5';

test('palette: the CLI and the status line share one palette of 7 distinct colors', () => {
  assert.deepStrictEqual(AGENT_PALETTE, PALETTE);
  assert.strictEqual(new Set(PALETTE).size, 7);
  for (const c of PALETTE) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('palette: the orchestrator blue is reserved, never an agent color', () => {
  assert.ok(!PALETTE.includes(ORCHESTRATOR_BLUE));
});

// ── assignment (pure) ──

test('assign: first agents take the palette in order', () => {
  let reg = {};
  const got = [];
  for (let i = 0; i < PALETTE.length; i++) {
    const r = assignColor(reg, `agent ${i}`, NOW + i);
    reg = r.registry;
    got.push(r.color);
  }
  assert.deepStrictEqual(got, PALETTE);
  assert.strictEqual(assignColor(reg, 'agent 8', NOW).color, PALETTE[0], 'all used once -> tie -> palette order');
});

test('assign: an existing agent keeps its color, and its entry is unchanged', () => {
  const reg = { Docs: { color: PALETTE[3], assigned: at(NOW - HOUR) } };
  const r = assignColor(reg, 'Docs', NOW);
  assert.strictEqual(r.color, PALETTE[3]);
  assert.deepStrictEqual(r.registry, reg);
});

test('assign: an entry holding a retired color is reassigned from the current palette', () => {
  const reg = {
    Retired: { color: ORCHESTRATOR_BLUE.toUpperCase(), assigned: at(NOW - HOUR) },
    Other: { color: ORCHESTRATOR_BLUE, assigned: at(NOW - HOUR) },
    a: { color: PALETTE[0], assigned: at(NOW - HOUR) }
  };
  const r = assignColor(reg, 'Retired', NOW);
  assert.strictEqual(r.color, PALETTE[1], 'least used, retired uses not counted');
  assert.deepStrictEqual(r.registry.Retired, { color: PALETTE[1], assigned: at(NOW) });
  assert.deepStrictEqual(r.registry.Other, reg.Other, 'other entries wait until they are asked for');
  assert.strictEqual(assignColor(r.registry, 'Retired', NOW + HOUR).color, PALETTE[1], 'then kept');
});

test('assign: least used in the last 24 h wins; older entries do not count', () => {
  const reg = {
    a: { color: PALETTE[0], assigned: at(NOW - HOUR) },
    b: { color: PALETTE[0], assigned: at(NOW - 2 * HOUR) },
    c: { color: PALETTE[2], assigned: at(NOW - HOUR) },
    // Old (2 days) uses of 1 don't count, so 1 is unused today and comes first among the unused.
    d: { color: PALETTE[1], assigned: at(NOW - 2 * 24 * HOUR) },
    e: { color: PALETTE[1], assigned: at(NOW - 3 * 24 * HOUR) }
  };
  for (let i = 3; i < PALETTE.length; i++) reg[`x${i}`] = { color: PALETTE[i], assigned: at(NOW - HOUR) };
  assert.strictEqual(assignColor(reg, 'new', NOW).color, PALETTE[1]);
});

test('assign: ties go to palette order', () => {
  const reg = {
    a: { color: PALETTE[0], assigned: at(NOW - HOUR) },
    b: { color: PALETTE[2], assigned: at(NOW - HOUR) }
  };
  assert.strictEqual(assignColor(reg, 'new', NOW).color, PALETTE[1]);
});

test('assign: entries older than 7 days and malformed ones are dropped', () => {
  const reg = {
    old: { color: PALETTE[0], assigned: at(NOW - KEEP_MS - 1) },
    edge: { color: PALETTE[1], assigned: at(NOW - KEEP_MS) },
    week: { color: PALETTE[2], assigned: at(NOW - RECENT_MS - 1) },
    noTime: { color: PALETTE[3] },
    badColor: { color: 'blue', assigned: at(NOW) },
    junk: 'x'
  };
  const r = assignColor(reg, 'new', NOW);
  assert.deepStrictEqual(Object.keys(r.registry).sort(), ['edge', 'new', 'week']);
  assert.strictEqual(r.color, PALETTE[0], 'nothing assigned in the last 24 h -> first color');
  assert.strictEqual(r.registry.new.assigned, at(NOW));
});

// ── the CLI ──

function runCli(home, name) {
  return spawnSync(process.execPath, [CLI, name], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
}

test('cli: prints the hex, saves the entry, and answers the same next time', () => {
  const home = makeHome();
  try {
    const first = runCli(home, 'Timeline label clipping');
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(first.stdout, `${PALETTE[0]}\n`);
    const file = path.join(home, '.claude', 'agent-colors.json');
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(reg['Timeline label clipping'].color, PALETTE[0]);
    assert.ok(!Number.isNaN(Date.parse(reg['Timeline label clipping'].assigned)));
    assert.strictEqual(runCli(home, 'Timeline label clipping').stdout, `${PALETTE[0]}\n`);
    assert.strictEqual(runCli(home, 'Agent colors').stdout, `${PALETTE[1]}\n`);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude')).filter(f => f.startsWith('agent-colors')), ['agent-colors.json'], 'no temp or lock file left');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cli: a corrupt registry is replaced, not fatal; no name is a usage error', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, '.claude', 'agent-colors.json'), '{not json');
    const r = runCli(home, 'x');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `${PALETTE[0]}\n`);
    assert.strictEqual(spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { ...process.env, HOME: home } }).status, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cli: calls at once keep every entry, each a different color', async () => {
  const home = makeHome();
  try {
    const names = PALETTE.map((_, i) => `parallel agent ${i}`);
    const outs = await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, name], { env: { ...process.env, HOME: home, USERPROFILE: home } });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
    })));
    const reg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'agent-colors.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(reg).sort(), [...names].sort(), 'no entry lost');
    assert.deepStrictEqual([...outs].sort(), [...PALETTE].sort(), 'each got its own color');
    names.forEach((name, i) => assert.strictEqual(reg[name].color, outs[i], 'printed what it saved'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── fallback hash ──

test('hash: stable per name, always a palette color, and spread over it', () => {
  assert.strictEqual(agentHashColor('Agent colors'), agentHashColor('Agent colors'));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = agentHashColor(`agent ${i}`);
    assert.ok(AGENT_PALETTE.includes(c));
    seen.add(c);
  }
  assert.strictEqual(seen.size, AGENT_PALETTE.length);
});

test('hash: the registry color wins; a missing or malformed one falls back to the hash', () => {
  const reg = { a: { color: '#ABCDEF' }, b: { color: 'red' } };
  assert.strictEqual(agentColorOf(reg, 'a'), '#abcdef');
  assert.strictEqual(agentColorOf(reg, 'b'), agentHashColor('b'));
  assert.strictEqual(agentColorOf(reg, 'c'), agentHashColor('c'));
  assert.strictEqual(agentColorOf(null, 'c'), agentHashColor('c'));
});

// ── the row ──

const task = {
  id: 't', description: 'Agent colors', model: 'claude-opus-5-5', effort: 'high',
  tokenCount: 40000, contextWindowSize: 200000, startTime: Date.now() - 65000
};

test('row: name bold in its color, then activity (dim), model, bar, time, cost', () => {
  const row = renderSubagentTask({ ...task, label: 'Running npm test' }, { usd: 1.5 }, { color: '#c78bf0' });
  assert.ok(row.startsWith(`\x1b[1m${ansiOf('#c78bf0')}Agent colors\x1b[0m`), JSON.stringify(row));
  assert.ok(row.includes('\x1b[2mRunning npm test\x1b[0m'), 'activity is dim');
  const parts = clean(row).split(' │ ');
  assert.deepStrictEqual(parts.slice(0, 3), ['Agent colors', 'Running npm test', 'Opus 5.5 · high']);
  assert.match(parts[3], /^C20 /);
  assert.match(parts[4], /^⏱ 1m\d+s$/);
  assert.strictEqual(parts[5], '$1.50');
});

test('row: no activity -> no segment; no color given -> the hash color', () => {
  for (const label of [undefined, '', '   ']) {
    const row = renderSubagentTask({ ...task, label });
    assert.deepStrictEqual(clean(row).split(' │ ').slice(0, 2), ['Agent colors', 'Opus 5.5 · high']);
    assert.ok(row.includes(ansiOf(agentHashColor('Agent colors'))));
  }
});

test('row: activity equal to the name (no live activity) -> the name once', () => {
  for (const label of ['Agent colors', '  Agent   colors\n']) {
    const row = clean(renderSubagentTask({ ...task, label }));
    assert.deepStrictEqual(row.split(' │ ').slice(0, 2), ['Agent colors', 'Opus 5.5 · high'], JSON.stringify(label));
  }
  const other = clean(renderSubagentTask({ ...task, label: 'Agent colors test' }));
  assert.deepStrictEqual(other.split(' │ ').slice(0, 3), ['Agent colors', 'Agent colors test', 'Opus 5.5 · high']);
});

test('row: activity is cut with "…" so the row fits the width, panel indent included', () => {
  const label = 'Reading statusline.js to find where the subagent row is drawn and how wide it is';
  const full = clean(renderSubagentTask({ ...task, label }, null, { cols: 500 }));
  assert.ok(full.includes(label), 'room enough -> whole');
  for (const cols of [64, 72, 90]) {
    const row = clean(renderSubagentTask({ ...task, label }, null, { cols }));
    assert.strictEqual([...row].length, cols - 4, `cols ${cols}: row fills the width less the indent`);
    assert.match(row.split(' │ ')[1], /…$/);
  }
  const narrow = clean(renderSubagentTask({ ...task, label }, null, { cols: 40 }));
  assert.deepStrictEqual(narrow.split(' │ ').slice(0, 2), ['Agent colors', 'Opus 5.5 · high'], 'no room -> dropped');
  const unknown = clean(renderSubagentTask({ ...task, label }, null, {})).split(' │ ')[1];
  assert.strictEqual([...unknown].length, 48, 'unknown width -> ACTIVITY_MAX');
  assert.match(unknown, /…$/);
  assert.strictEqual(clean(renderSubagentTask({ ...task, label: 'a\n  b' })).split(' │ ')[1], 'a b', 'one line');
});

test('row: subagent mode reads the registry color and COLUMNS', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, '.claude', 'agent-colors.json'), JSON.stringify({ 'Agent colors': { color: '#c78bf0', assigned: new Date().toISOString() } }));
    const input = JSON.stringify({ tasks: [{ ...task, label: 'x'.repeat(200) }] });
    const res = spawnSubagent(input, { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: '80' });
    const { content } = JSON.parse(res.stdout.trim());
    assert.ok(content.includes(ansiOf('#c78bf0')), 'registry color');
    assert.strictEqual([...clean(content)].length, 76);
    assert.ok(!fs.readdirSync(path.join(home, '.claude')).some(f => f.endsWith('.lock') || f.endsWith('.tmp')), 'read-only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
