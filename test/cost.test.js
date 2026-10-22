// Each subagent row's cost: the dollars of its transcript (<session>/subagents/agent-<id>.jsonl
// beside stdin's transcript_path), priced per reply like Claude Code prices the session. Pricing
// and formatting call the pure helpers; reading transcripts (dedupe, incremental reads, partial
// lines, the subagent lookup, CTXLINE_DISABLE=cost) spawns the real script against synthetic
// transcripts in a fake HOME. No network, no real transcripts.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome, spawnMain, spawnSubagent } = require('./fixture.js');
const { renderStatusLine, renderSubagentTask, formatUsd, usageCost } = require('../statusline.js');

const HOMES = [];
after(() => {
  for (const home of HOMES) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A fake HOME with an empty transcript at <home>/projects/p/session.jsonl.
function setup() {
  const home = makeHome();
  HOMES.push(home);
  const dir = path.join(home, 'projects', 'p');
  fs.mkdirSync(path.join(dir, 'session', 'subagents'), { recursive: true });
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  return { home, transcript, subagents: path.join(dir, 'session', 'subagents') };
}

// One assistant record as Claude Code logs it (Opus 5.5 unless given). `usage` fields default to 0.
function reply(id, { input = 0, read = 0, write = 0, output, model = 'claude-opus-5-5', content = [] } = {}) {
  const usage = { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write };
  if (output != null) usage.output_tokens = output;
  return JSON.stringify({ type: 'assistant', isSidechain: true, message: { id, model, role: 'assistant', content, usage } }) + '\n';
}

// The child's env: the fake HOME, no usage fetch, no COLUMNS, and CTXLINE_DISABLE only when given.
function env(home, disable) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: 'test' };
  delete e.COLUMNS;
  if (disable) e.CTXLINE_DISABLE = disable;
  else delete e.CTXLINE_DISABLE;
  return e;
}

// The main line, ANSI stripped, for a payload whose transcript_path is `transcript`.
function mainLine(home, transcript) {
  const input = JSON.stringify({
    model: { display_name: 'Opus 5.5' },
    workspace: { current_dir: '/tmp/myproject' },
    session_id: 'session',
    transcript_path: transcript,
    context_window: { remaining_percentage: 70 },
    cost: { total_cost_usd: 12.5 }
  });
  const res = spawnMain(input, env(home));
  assert.strictEqual(res.status, 0);
  return clean(res.stdout || '');
}

// The subagent rows ({ id, content }, content ANSI stripped) for `tasks` in that session.
function subagentRows(home, transcript, tasks, disable) {
  const res = spawnSubagent(JSON.stringify({ session_id: 'session', transcript_path: transcript, tasks }), env(home, disable));
  assert.strictEqual(res.status, 0);
  const raw = (res.stdout || '').trim();
  return raw ? raw.split('\n').map(l => JSON.parse(l)).map(r => ({ id: r.id, content: clean(r.content) })) : [];
}

// The cost segment of a subagent row, or '' when it has none.
const costOf = (row) => row.split(' │ ').find(s => /^\$\d+\.\d\d…?$/.test(s)) || '';

// A subagent row (ANSI stripped) for task a1, whose transcript holds `lines`.
function agentRow(lines, task = { id: 'a1', description: 'Review parser' }, disable) {
  const { home, transcript, subagents } = setup();
  fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), lines.join(''));
  const rows = subagentRows(home, transcript, [task], disable);
  return { home, transcript, subagents, row: rows[0]?.content || '' };
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ── dollars format ──

test('cost: dollars always carry two decimals', () => {
  assert.strictEqual(formatUsd(0), '$0.00');
  assert.strictEqual(formatUsd(0.4213), '$0.42');
  assert.strictEqual(formatUsd(2.999), '$3.00');
  assert.strictEqual(formatUsd(1318.394), '$1318.39');
  assert.strictEqual(formatUsd(-0.2), '$0.00');
});

test('cost: the main line keeps its $ segment from stdin and has no token counts', () => {
  const facts = { dirname: 'myproject', cols: undefined, task: 'Writing tests' };
  const parts = clean(renderStatusLine({ cost: { total_cost_usd: 1318.394 } }, facts, null)).split(' │ ');
  assert.deepStrictEqual(parts.slice(-2), ['$1318.39', 'Writing tests']);
  assert.ok(!parts.some(p => /^R\S+ I\S+ O/.test(p)), 'no R/I/O token segment');
});

test('cost: the main line reads no transcript', () => {
  const { home, transcript } = setup();
  fs.writeFileSync(transcript, reply('m1', { read: 1000, output: 10 }));
  assert.ok(mainLine(home, transcript).endsWith('$12.50'));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'cache', 'tokens')), 'nothing read, nothing cached');
});

test('cost: a subagent row ends with its dollars, dim; "…" while catching up; none at zero', () => {
  const content = renderSubagentTask({ id: 't', description: 'Review parser', startTime: Date.now() - 5000 }, { usd: 0.4213 });
  assert.match(clean(content), /^Review parser │ ⏱ \d+s │ \$0\.42$/);
  assert.ok(content.includes('\x1b[2m$0.42'), 'cost is dim, like the main line');
  assert.strictEqual(clean(renderSubagentTask({ id: 't', description: 'x' }, { usd: 3, partial: true })), 'x │ $3.00…');
  for (const cost of [undefined, null, { usd: 0 }]) {
    assert.strictEqual(clean(renderSubagentTask({ id: 't', description: 'x' }, cost)), 'x');
  }
});

// ── row name ──

test('subagent name: the spawn description, then the live activity label beside it', () => {
  const row = (t) => clean(renderSubagentTask({ id: 't', ...t }));
  assert.strictEqual(row({ description: 'Reply colors plugin', label: 'Waiting on the build', name: 'colors' }), 'Reply colors plugin │ Waiting on the build');
  assert.strictEqual(row({ name: 'colors', label: 'Waiting on the build' }), 'colors │ Waiting on the build');
  assert.strictEqual(row({ label: 'Waiting on the build' }), 'agent │ Waiting on the build');
  assert.strictEqual(row({}), 'agent');
});

// ── pricing (Claude Code's catalog) ──

test('pricing: Opus 5.5 with 1h cache writes matches what Claude Code charged for a real session', () => {
  // implot session: Claude Code's lastModelUsage costUSD 0.228278 for these counts.
  near(usageCost('claude-opus-5-5', {
    input_tokens: 2, output_tokens: 1599, cache_read_input_tokens: 25050, cache_creation_input_tokens: 23910,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 23910 }
  }), 0.228278);
});

test('pricing: each token kind at its own rate', () => {
  const m = 1e6;
  near(usageCost('claude-opus-5-5', { input_tokens: m }), 4);
  near(usageCost('claude-opus-5-5', { output_tokens: m }), 20);
  near(usageCost('claude-opus-5-5', { cache_read_input_tokens: m }), 0.2);
  near(usageCost('claude-opus-5-5', { cache_creation_input_tokens: m }), 5);
  near(usageCost('claude-sonnet-5-5', { cache_read_input_tokens: m }), 0.1);
  near(usageCost('claude-fable-5-1', { input_tokens: m, cache_read_input_tokens: m }), 10.25);
  near(usageCost('claude-haiku-4-5', { output_tokens: m }), 5);
});

test('pricing: model ids are matched in every form Claude Code logs', () => {
  const opus4 = usageCost('claude-opus-4-20250514', { input_tokens: 1e6 });
  near(opus4, 15);
  near(usageCost('claude-opus-5[1m]', { input_tokens: 1e6 }), 5);
  near(usageCost('us.anthropic.claude-sonnet-4-5-20250929-v1:0', { input_tokens: 1e6 }), 3);
  near(usageCost('claude-haiku-4-5-20251001', { input_tokens: 1e6 }), 1);
  near(usageCost('some-new-model', { input_tokens: 1e6 }), 5); // unknown: Claude Code's default
});

test('pricing: fast mode, long Haiku 5.5 prompts, US-only inference and web searches', () => {
  near(usageCost('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  near(usageCost('claude-opus-5', { output_tokens: 1e6, speed: 'fast' }), 50);
  near(usageCost('claude-sonnet-5', { output_tokens: 1e6, speed: 'fast' }), 10); // no fast rates
  near(usageCost('claude-haiku-5-5', { input_tokens: 100000 }), 0.01);
  near(usageCost('claude-haiku-5-5', { input_tokens: 100001 }), 100001 * 0.5 / 1e6);
  near(usageCost('claude-opus-5-5', { input_tokens: 1e6, inference_geo: 'us' }), 4.4);
  near(usageCost('claude-opus-5-5', { server_tool_use: { web_search_requests: 3 } }), 0.03);
});

// ── reading transcripts (spawned) ──

test('cost: a reply logged once per content block counts once', () => {
  const { row } = agentRow([
    reply('m1', { read: 1e6, output: 50000 }),          // $0.20 + $1.00
    reply('m1', { read: 1e6, output: 50000 }),          // same reply, next block
    reply('m2', { write: 200000, output: 0 })           // $1.00
  ]);
  assert.strictEqual(costOf(row), '$2.20');
});

test('cost: output is at least what the reply wrote, when its usage was logged mid-stream', () => {
  const text = (n) => ({ type: 'text', text: 'x'.repeat(n) });
  const { row } = agentRow([
    reply('m1', { output: 8, content: [text(20000)] }),
    reply('m1', { output: 8, content: [{ type: 'tool_use', input: { s: 'y'.repeat(19990) } }] })
  ]);
  // 20000 + 20000 characters ≈ 10000 output tokens at $20/M.
  assert.strictEqual(costOf(row), '$0.20');
});

test('cost: later renders add only what was appended, one state file per transcript', () => {
  const { home, transcript, subagents, row } = agentRow([reply('m1', { read: 1e6 })]);
  assert.strictEqual(costOf(row), '$0.20');
  fs.appendFileSync(path.join(subagents, 'agent-a1.jsonl'), reply('m2', { read: 2e6 }));
  assert.strictEqual(costOf(subagentRows(home, transcript, [{ id: 'a1' }])[0].content), '$0.60');
  assert.strictEqual(fs.readdirSync(path.join(home, '.claude', 'cache', 'tokens')).length, 1);
});

test('cost: a half-written last line waits for the next render', () => {
  const second = reply('m2', { read: 2e6 });
  const { home, transcript, subagents, row } = agentRow([reply('m1', { read: 1e6 }), second.slice(0, 20)]);
  assert.strictEqual(costOf(row), '$0.20');
  fs.appendFileSync(path.join(subagents, 'agent-a1.jsonl'), second.slice(20));
  assert.strictEqual(costOf(subagentRows(home, transcript, [{ id: 'a1' }])[0].content), '$0.60');
});

test('cost: a transcript that shrank, or a state file of the old token format, is counted again', () => {
  const { home, transcript, subagents } = agentRow([reply('m1', { read: 1e6 }), reply('m2', { read: 2e6 })]);
  const file = path.join(subagents, 'agent-a1.jsonl');
  fs.writeFileSync(file, reply('m3', { read: 5e6 }));
  assert.strictEqual(costOf(subagentRows(home, transcript, [{ id: 'a1' }])[0].content), '$1.00');
  const dir = path.join(home, '.claude', 'cache', 'tokens');
  const [state] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, state), JSON.stringify({ ino: fs.statSync(file).ino, offset: 0, totals: [0, 0, 0, 0], recent: [] }));
  assert.strictEqual(costOf(subagentRows(home, transcript, [{ id: 'a1' }])[0].content), '$1.00');
});

test('cost: a subagent with no file of its id is found by the description in its meta', () => {
  const { home, transcript, subagents } = setup();
  fs.writeFileSync(path.join(subagents, 'agent-zz.jsonl'), reply('x1', { read: 1e6 }));
  fs.writeFileSync(path.join(subagents, 'agent-zz.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the parser' }));
  const rows = subagentRows(home, transcript, [{ id: 'other-id', description: 'Find the parser' }]);
  assert.strictEqual(rows[0].content, 'Find the parser │ $0.20');
});

test('cost: no transcript -> no cost segment; CTXLINE_DISABLE=cost skips the read', () => {
  const { home, transcript } = setup();
  assert.deepStrictEqual(subagentRows(home, transcript, [{ id: 'a1', description: 'x' }]), [{ id: 'a1', content: 'x' }]);
  const { home: h2, row } = agentRow([reply('m1', { read: 1e6 })], { id: 'a1', description: 'x' }, 'cost');
  assert.strictEqual(row, 'x');
  assert.ok(!fs.existsSync(path.join(h2, '.claude', 'cache', 'tokens')), 'nothing read, nothing cached');
});

// ── cache lifetime ──

test('cost: a new state file clears others not written for 30 days, and keeps recent ones', () => {
  const { home, transcript } = setup();
  const dir = path.join(home, '.claude', 'cache', 'tokens');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.json');
  const recent = path.join(dir, 'recent.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(recent, '{}');
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(recent, new Date(Date.now() - 29 * 24 * 60 * 60 * 1000), new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
  fs.writeFileSync(path.join(path.dirname(transcript), 'session', 'subagents', 'agent-a1.jsonl'), reply('m1', { read: 1e6 }));
  assert.strictEqual(subagentRows(home, transcript, [{ id: 'a1', description: 'x' }])[0].content, 'x │ $0.20');
  assert.ok(!fs.existsSync(old), 'a state file untouched for 31 days is deleted');
  assert.ok(fs.existsSync(recent), 'one written 29 days ago stays');
  assert.strictEqual(fs.readdirSync(dir).length, 2, "the transcript's own state file and the recent one");
});

test('cost: uninstall removes the cost cache', () => {
  const { home } = setup();
  const dir = path.join(home, '.claude', 'cache', 'tokens');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  const res = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'install.js'), 'uninstall'], {
    encoding: 'utf8', timeout: 10000, env: env(home)
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(!fs.existsSync(dir), 'cache/tokens is gone');
});
