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
const { renderSubagentTask, renderSubagentRows, agentHashColor, agentColorOf, AGENT_PALETTE } = require('../statusline.js');

const CLI = path.join(__dirname, '..', 'agent-color.js');
const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const at = (ms) => new Date(ms).toISOString();
const ansiOf = (hex) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;

// ── palette ──

const ORCHESTRATOR_BLUE = '#5bb8f5';

test('palette: the CLI and the status line share one palette of 16 distinct colors', () => {
  assert.deepStrictEqual(AGENT_PALETTE, PALETTE);
  assert.strictEqual(new Set(PALETTE).size, 16);
  for (const c of PALETTE) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('palette: the orchestrator blue is reserved, never an agent color', () => {
  assert.ok(!PALETTE.includes(ORCHESTRATOR_BLUE));
});

// The colors an agent name must stay clear of, from Breno's terminal (kitty, gruvbox dark) and the
// orchestrator's conventions: the default text and background, the orchestrator's blue, the tints
// of the words "questions", "review" and "answers" in its blocks, and the named colors Claude uses
// for meaning.
const DEFAULT_TEXT = '#ebdbb2';
const RESERVED = {
  'default text': DEFAULT_TEXT,
  background: '#282828',
  'orchestrator blue': ORCHESTRATOR_BLUE,
  'questions tint': '#e19c60',
  'review tint': '#c2b966',
  'answers tint': '#87a799',
  green: '#98971a',
  red: '#cc241d',
  magenta: '#b16286',
  gray: '#928374'
};
const MIN_DELTA_E = 25;
// Agents take the palette in order, so neighbors in it must look unlike each other.
const MIN_NEIGHBOR_DELTA_E = 40;

// CIELAB (D65) from sRGB hex; ΔE76 is the Euclidean distance between two of them.
function lab(hex) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test('palette: ΔE matches known reference values', () => {
  assert.ok(Math.abs(deltaE('#000000', '#ffffff') - 100) < 0.01);
  assert.ok(Math.abs(lab('#ff0000')[1] - 80.1) < 0.2, 'red a*');
});

test('palette: every color is at least ΔE 25 from the default text and the reserved colors', () => {
  const close = [];
  for (const c of PALETTE) {
    for (const [what, r] of Object.entries(RESERVED)) {
      const d = deltaE(c, r);
      if (d < MIN_DELTA_E) close.push(`${c} vs ${what} ${r}: ${d.toFixed(1)}`);
    }
  }
  assert.deepStrictEqual(close, []);
});

// WCAG 2 contrast ratio of two sRGB hex colors.
function contrast(a, b) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('palette: every color is readable on the background (WCAG contrast at least 4.5)', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  const low = PALETTE.filter(c => contrast(c, RESERVED.background) < 4.5);
  assert.deepStrictEqual(low, []);
});

test('palette: consecutive colors, wrapping around, are at least ΔE 40 apart', () => {
  const close = [];
  for (let i = 0; i < PALETTE.length; i++) {
    const [a, b] = [PALETTE[i], PALETTE[(i + 1) % PALETTE.length]];
    const d = deltaE(a, b);
    if (d < MIN_NEIGHBOR_DELTA_E) close.push(`${a} then ${b}: ${d.toFixed(1)}`);
  }
  assert.deepStrictEqual(close, []);
});

test('palette: every two agent colors are at least ΔE 25 apart', () => {
  const close = [];
  for (let i = 0; i < PALETTE.length; i++) {
    for (let j = i + 1; j < PALETTE.length; j++) {
      const d = deltaE(PALETTE[i], PALETTE[j]);
      if (d < MIN_DELTA_E) close.push(`${PALETTE[i]} vs ${PALETTE[j]}: ${d.toFixed(1)}`);
    }
  }
  assert.deepStrictEqual(close, []);
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
  assert.strictEqual(assignColor(reg, 'one more', NOW).color, PALETTE[0], 'all used once -> tie -> palette order');
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

test('assign: retired palette colors are reassigned on the next lookup', () => {
  const retired = [
    '#f4a582', '#7b8cff', '#d8c8a0',
    '#c78bf0', '#3fc9b0', '#fca8a0', '#6888f8', '#8cb084', '#a8e6ef', '#c2b5f7'
  ];
  for (const old of retired) {
    const r = assignColor({ Agent: { color: old, assigned: at(NOW - HOUR) } }, 'Agent', NOW);
    assert.notStrictEqual(r.color, old);
    assert.ok(PALETTE.includes(r.color), `${old} -> ${r.color}`);
  }
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

// ── the rows, aligned ──

// Terminal cells of a character: two for CJK, one otherwise (enough for these rows).
const cellsOf = (ch) => (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1);
// Cell offsets of every "│" in a rendered row.
const barColumns = (row) => {
  let at = 0;
  return [...clean(row)].flatMap((ch) => { const here = at; at += cellsOf(ch); return ch === '│' ? [here] : []; });
};
const fleet = [
  { task: { ...task, id: 'a', description: 'memory-leak-notebook', label: 'Polling soak run logs for completion', tokenCount: 82000, startTime: Date.now() - 4 * 3600e3 - 20 * 60e3 }, cost: { usd: 51.04 }, color: '#b868fc' },
  { task: { ...task, id: 'b', description: 'lm-walks-default', label: 'Confirming clean imu_fusion_config.h commit', tokenCount: 9000, startTime: Date.now() - 45000 }, cost: { usd: 7.2 }, color: '#06d2f0' },
  { task: { ...task, id: 'c', description: 'parity-batch', model: 'claude-sonnet-5', effort: 'medium', label: 'Writing session.sh', tokenCount: 200000, startTime: Date.now() - 2 * 3600e3 }, cost: { usd: 4.38 }, color: '#0094f4' },
  { task: { ...task, id: 'd', description: 'x', label: 'Reading the agent panel docs to see how wide a row may be', startTime: Date.now() - 600e3 }, cost: { usd: 0.05 }, color: '#709c5c' }
];

test('rows: every separator sits at the same column in every row', () => {
  for (const cols of [undefined, 200, 120]) {
    const rows = renderSubagentRows(fleet, { cols });
    assert.strictEqual(rows.length, fleet.length);
    const first = barColumns(rows[0]);
    assert.strictEqual(first.length, 5, `cols ${cols}: six segments`);
    for (const row of rows) assert.deepStrictEqual(barColumns(row), first, `cols ${cols}:\n${rows.map(clean).join('\n')}`);
    const widths = new Set(rows.map(r => [...clean(r)].length));
    assert.strictEqual(widths.size, 1, 'every row ends at the same column');
  }
});

test('rows: numbers are right-aligned, names and activity left-aligned', () => {
  const rows = renderSubagentRows(fleet, { cols: 200 }).map(clean);
  const seg = (row, i) => row.split('│')[i];
  assert.match(seg(rows[3], 0), /^x {20}$/, 'name padded at its end');
  assert.match(seg(rows[0], 5), /^ \$51\.04$/);
  assert.match(seg(rows[2], 5), /^  \$4\.38$/);
  assert.match(seg(rows[1], 3), /^   C5 /, 'context number right-aligned under C100');
  assert.match(seg(rows[1], 4), /^ ⏱   \d\ds $/, 'elapsed right-aligned after the stopwatch');
  assert.match(seg(rows[2], 1), /^ Writing session\.sh +$/, 'short activity padded');
});

test('rows: a narrow terminal shrinks the activity column for every row, then drops it', () => {
  const wide = renderSubagentRows(fleet, { cols: 200 }).map(clean);
  const activityWidth = (rows) => rows[0].split('│')[1].length;
  for (const cols of [100, 90]) {
    const rows = renderSubagentRows(fleet, { cols });
    for (const row of rows) assert.strictEqual([...clean(row)].length, cols - 4, `cols ${cols}: fits less the indent`);
    for (const row of rows) assert.deepStrictEqual(barColumns(row), barColumns(rows[0]));
    assert.ok(activityWidth(rows.map(clean)) < activityWidth(wide));
    assert.match(clean(rows[0]).split('│')[1], /… $/, 'cut with "…"');
  }
  const narrow = renderSubagentRows(fleet, { cols: 60 }).map(clean);
  for (const row of narrow) {
    assert.strictEqual(row.split('│').length, 5, 'activity dropped from every row');
    assert.deepStrictEqual(barColumns(row), barColumns(narrow[0]));
  }
});

test('rows: a missing segment leaves a gap and the other columns stay aligned', () => {
  const sparse = [
    fleet[0],
    { task: { id: 'e', description: 'no-effort', model: 'claude-opus-5-5', label: 'Waiting', startTime: Date.now() - 5000 }, cost: null },
    { task: { id: 'f', description: 'bare', label: 'bare' }, cost: null },
    { task: { ...task, id: 'g', description: 'no-activity', label: undefined }, cost: { usd: 2 } }
  ];
  const rows = renderSubagentRows(sparse, { cols: 200 });
  const full = barColumns(rows[0]);
  const plain = rows.map(clean);
  // Every row's separators are the full row's, cut where its own segments end.
  for (const row of rows) assert.deepStrictEqual(barColumns(row), full.slice(0, barColumns(row).length), plain.join('\n'));
  assert.strictEqual(plain[2].trimEnd(), plain[2], 'no trailing padding');
  assert.strictEqual(plain[2], 'bare', 'nothing past the name, the label equal to it dropped');
  assert.match(plain[1], /│ Opus 5\.5 +│ +│/, 'model alone, context gap kept');
  assert.match(plain[3].split('│')[1], /^ +$/, 'activity gap kept');
  assert.strictEqual(plain[3].split('│')[5].trim(), '$2.00');
});

test('rows: wide glyphs count two cells', () => {
  const rows = renderSubagentRows([
    { task: { ...task, id: 'a', description: '测试代理', label: 'go' }, cost: null },
    { task: { ...task, id: 'b', description: 'abcdefghij', label: 'go' }, cost: null }
  ], { cols: 200 });
  assert.deepStrictEqual(barColumns(rows[0]), barColumns(rows[1]), rows.map(clean).join('\n'));
});

test('rows: subagent mode aligns the rows of every task in one payload', () => {
  const home = makeHome();
  try {
    const input = JSON.stringify({ tasks: fleet.map(e => e.task) });
    const res = spawnSubagent(input, { ...process.env, HOME: home, USERPROFILE: home, COLUMNS: '120' });
    const rows = res.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(rows.map(r => r.id), ['a', 'b', 'c', 'd']);
    for (const { content } of rows) assert.deepStrictEqual(barColumns(content), barColumns(rows[0].content));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
