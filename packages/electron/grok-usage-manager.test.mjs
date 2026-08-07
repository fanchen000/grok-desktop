import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { GrokUsageManager, parseGrokUsageOutput } from './grok-usage-manager.mjs';

const accountManager = {
  list: () => ({ currentId: 'default' }),
  activeEnvironment: () => ({}),
  environmentFor: (id) => ({ HOME: `home-${id}`, USERPROFILE: `home-${id}` }),
};

test('parses the official weekly usage percentage and reset time', () => {
  const result = parseGrokUsageOutput('\u001b[2JWeekly limit: 5%\r\nNext reset: August 10, 13:05\u001b[0m', Date.parse('2026-08-07T08:00:00+08:00'));
  assert.equal(result.period, 'weekly');
  assert.equal(result.usedPercent, 5);
  assert.equal(result.remainingPercent, 95);
  assert.equal(result.resetLabel, 'August 10, 13:05');
  assert.ok(Number.isFinite(result.resetAt));
});

test('returns null instead of guessing when official usage is absent', () => {
  assert.equal(parseGrokUsageOutput('Grok Build ready'), null);
});

test('reuses one official Grok TUI, caches the result, and cleans only its probe session on close', async () => {
  const calls = [];
  const runtimeHomes = [];
  let ptyHome = null;
  let writes = 0;
  let listCount = 0;
  const createdSessionId = '019fd9a3-b1ef-7af0-85a7-8047b8891746';
  const execFileImpl = async (_program, args, options) => {
    calls.push(args);
    runtimeHomes.push(options.env.HOME);
    if (args[0] === 'sessions' && args[1] === 'list') {
      listCount += 1;
      return {
        stdout: listCount === 1
          ? '019e9107-7465-78c1-86ac-55127a064314  2026-06-04  2026-06-04  remote  existing'
          : `019e9107-7465-78c1-86ac-55127a064314  2026-06-04  2026-06-04  remote  existing\n${createdSessionId}  2026-08-07  2026-08-07  local  probe`,
      };
    }
    return { stdout: '' };
  };
  const fakePty = new EventEmitter();
  fakePty.write = (value) => {
    assert.equal(value, '/usage\r');
    writes += 1;
    setTimeout(() => fakePty.emit('data', 'Weekly limit: 12%\r\nNext reset: August 11, 09:00'), 220);
  };
  fakePty.kill = () => queueMicrotask(() => fakePty.emit('exit', { exitCode: 0 }));
  fakePty.onData = (handler) => { fakePty.on('data', handler); return { dispose() {} }; };
  fakePty.onExit = (handler) => { fakePty.on('exit', handler); return { dispose() {} }; };
  const manager = new GrokUsageManager({
    grokPath: 'grok',
    accountManager,
    probeDirectory: process.cwd(),
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
    execFileImpl,
    ptyModuleLoader: async () => ({
      spawn: (_program, _args, options) => {
        ptyHome = options.env.HOME;
        queueMicrotask(() => fakePty.emit('data', 'minimal · /help 10K / 500K (2%)'));
        return fakePty;
      },
    }),
    now: () => Date.parse('2026-08-07T08:00:00+08:00'),
  });

  const first = await manager.get();
  const second = await manager.get();
  assert.equal(first.usedPercent, 12);
  assert.equal(first.status, 'ready');
  assert.equal(second, first);
  assert.equal(ptyHome, 'home-default');
  assert.equal(writes, 1);
  assert.ok(runtimeHomes.every((home) => home === 'home-default'));
  assert.deepEqual(calls.filter((args) => args[0] === 'sessions' && args[1] === 'delete'), []);
  await manager.close();
  assert.deepEqual(calls.filter((args) => args[0] === 'sessions' && args[1] === 'delete'), [
    ['sessions', 'delete', createdSessionId],
  ]);
});

test('keeps the last authoritative snapshot but marks it stale after refresh failure', async () => {
  let attempt = 0;
  const manager = new GrokUsageManager({
    grokPath: 'grok',
    accountManager,
    probeDirectory: process.cwd(),
    cacheTtlMs: 0,
    timeoutMs: 500,
    execFileImpl: async (_program, args) => {
      if (args[0] === 'sessions') return { stdout: '' };
      return { stdout: '' };
    },
    ptyModuleLoader: async () => ({
      spawn: () => {
        const fakePty = new EventEmitter();
        fakePty.write = () => {
          setTimeout(() => {
            if (attempt++ === 0) fakePty.emit('data', 'Weekly limit: 20%\nNext reset: August 12, 10:00');
            else fakePty.emit('exit', { exitCode: 1 });
          }, attempt === 0 ? 220 : 10);
        };
        fakePty.kill = () => undefined;
        fakePty.onData = (handler) => { fakePty.on('data', handler); return { dispose() {} }; };
        fakePty.onExit = (handler) => { fakePty.on('exit', handler); return { dispose() {} }; };
        queueMicrotask(() => fakePty.emit('data', 'minimal · /help'));
        return fakePty;
      },
    }),
  });
  const fresh = await manager.get({ force: true });
  const stale = await manager.get({ force: true });
  assert.equal(fresh.status, 'ready');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.usedPercent, 20);
  assert.match(stale.refreshError, /terminal exited/i);
  await manager.close();
});
