// The detached `update-check` child: records a newer release for the "available" row and never
// replaces the installed hook. https is stubbed by a preloaded module, so nothing leaves the host.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'statusline.js');

// Answers the npm registry with `latest` and any release download with a valid statusline.js
// declaring that version, and logs every requested path to LOG.
const STUB = `
const https = require('https');
const fs = require('fs');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const latest = process.env.STUB_LATEST;
https.request = (opts, onResponse) => {
  fs.appendFileSync(process.env.STUB_LOG, opts.hostname + opts.path + '\\n');
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => setImmediate(() => {
    const res = new PassThrough();
    res.statusCode = 200;
    onResponse(res);
    res.end(opts.hostname === 'registry.npmjs.org'
      ? JSON.stringify({ version: latest })
      : "const VERSION = '" + latest + "';\\n");
  });
  return req;
};
`;

function runUpdateCheck(latest) {
  // Real path: node resolves the main module through symlinks (macOS /var -> /private/var), and
  // the hook must match HOME's path for update-check to treat it as the installed hook.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-update-')));
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, 'statusline.js');
  fs.copyFileSync(SCRIPT, hook);
  const stub = path.join(home, 'stub.js');
  fs.writeFileSync(stub, STUB);
  const log = path.join(home, 'requests.log');
  fs.writeFileSync(log, '');
  const env = { HOME: home, USERPROFILE: home, STUB_LATEST: latest, STUB_LOG: log, PATH: process.env.PATH };
  const r = spawnSync(process.execPath, ['-r', stub, hook, 'update-check'], { env, encoding: 'utf8', timeout: 10000 });
  const cache = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cache', 'update-cache.json'), 'utf8'));
  const result = {
    status: r.status,
    hookUnchanged: fs.readFileSync(hook).equals(fs.readFileSync(SCRIPT)),
    requests: fs.readFileSync(log, 'utf8').trim().split('\n'),
    cache
  };
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test('update-check: a newer release is cached for the nudge, never installed over the hook', () => {
  const r = runUpdateCheck('99.0.0');
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(r.requests, ['registry.npmjs.org/ctxline-claude/latest'], 'no release download');
  assert.ok(r.hookUnchanged, 'installed hook left as it was');
  assert.strictEqual(r.cache.latest, '99.0.0');
  assert.ok(Number.isFinite(r.cache.checkedAt), 'successful check stamps checkedAt');
  assert.strictEqual(r.cache.updatedTo, undefined, 'no self-install recorded');
});
