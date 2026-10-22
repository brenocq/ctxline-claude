// install.sh from a checkout: installs the checkout's own statusline.js and agent-color.js and
// sets both settings entries, keeping every other key, under a throwaway HOME. Never touches the
// network: a checkout install downloads nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install.sh');
const skip = process.platform === 'win32' && 'install.sh is the macOS / Linux installer';

function makeHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-install-'));
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return home;
}

// PATH holds node and the system tools, plus a stub `capcom` when asked, so the host's own
// capcom never decides the outcome.
function runInstaller(home, { capcom = false, args = [] } = {}) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (capcom) fs.writeFileSync(path.join(bin, 'capcom'), '#!/bin/sh\ncat\n', { mode: 0o755 });
  const env = { HOME: home, PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') };
  return spawnSync('bash', [INSTALLER, ...args], { env, encoding: 'utf8' });
}

const readSettings = home => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));

test('installs the checkout files and keeps unrelated settings', { skip }, () => {
  const home = makeHome({ theme: 'dark', env: { A: '1' }, statusLine: { type: 'command', command: 'node old.js' } });
  fs.writeFileSync(path.join(home, '.claude', 'hooks', 'statusline.js'), 'old');
  try {
    const r = runInstaller(home, { capcom: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const hooks = path.join(home, '.claude', 'hooks');
    assert.ok(fs.readFileSync(path.join(hooks, 'statusline.js')).equals(fs.readFileSync(path.join(ROOT, 'statusline.js'))));
    assert.ok(fs.readFileSync(path.join(hooks, 'agent-color')).equals(fs.readFileSync(path.join(ROOT, 'agent-color.js'))));
    assert.ok(fs.statSync(path.join(hooks, 'agent-color')).mode & 0o100, 'agent-color is executable');

    const hook = path.join(hooks, 'statusline.js');
    const settings = readSettings(home);
    assert.strictEqual(settings.theme, 'dark');
    assert.deepStrictEqual(settings.env, { A: '1' });
    assert.deepStrictEqual(settings.statusLine, { type: 'command', command: `capcom record-limits | node "${hook}"`, refreshInterval: 1 });
    assert.deepStrictEqual(settings.subagentStatusLine, { type: 'command', command: `node "${hook}" subagent` });

    const backups = name => fs.readdirSync(path.dirname(name)).filter(f => f.startsWith(`${path.basename(name)}.backup.`));
    assert.strictEqual(backups(hook).length, 1, 'old statusline.js backed up');
    assert.strictEqual(backups(path.join(home, '.claude', 'settings.json')).length, 1, 'old settings backed up');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('without capcom on PATH the main line runs without the feed', { skip }, () => {
  const home = makeHome();
  try {
    const r = runInstaller(home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /capcom not found/);
    const hook = path.join(home, '.claude', 'hooks', 'statusline.js');
    assert.deepStrictEqual(readSettings(home).statusLine, { type: 'command', command: `node "${hook}"`, refreshInterval: 1 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--dry-run changes nothing', { skip }, () => {
  const original = { theme: 'dark' };
  const home = makeHome(original);
  try {
    const r = runInstaller(home, { capcom: true, args: ['--dry-run'] });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /would set statusLine\.command = capcom record-limits \| node/);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude', 'hooks')), []);
    assert.deepStrictEqual(readSettings(home), original);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.claude')).sort(), ['hooks', 'settings.json']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('invalid settings.json is left alone, not replaced', { skip }, () => {
  const home = makeHome();
  const file = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(file, '{not json');
  try {
    const r = runInstaller(home);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /not valid JSON/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{not json');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
