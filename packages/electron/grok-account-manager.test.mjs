import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGrokAccountManager } from './grok-account-manager.mjs';

const fixture = async (t, overrides = {}) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'grok-accounts-'));
  const changes = [];
  const manager = createGrokAccountManager({
    storageRoot: path.join(root, 'store'),
    grokPath: 'grok-test',
    defaultHome: path.join(root, 'system-home'),
    onActiveAccountChanging: async (account, env) => changes.push({ account, env }),
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  });
  await manager.load();
  t.after(async () => {
    await manager.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, manager, changes };
};

test('creates isolated accounts without copying the system credential', async (t) => {
  const { root, manager } = await fixture(t);
  const result = await manager.create('工作账号');
  const account = result.accounts.find((entry) => entry.label === '工作账号');
  assert.ok(account);
  const env = manager.environmentFor(account.id);
  assert.match(env.HOME, /profiles/);
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.GROK_HOME, path.join(env.HOME, '.grok'));
  assert.equal(fs.existsSync(path.join(env.HOME, '.grok', 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'system-home', '.grok', 'auth.json')), false);
});

test('switches the active account only after the runtime accepts the change', async (t) => {
  const { manager, changes } = await fixture(t);
  const created = await manager.create('第二账号');
  const account = created.accounts.find((entry) => entry.label === '第二账号');
  const result = await manager.switch(account.id);
  assert.equal(result.currentId, account.id);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].account.id, account.id);
  assert.equal(changes[0].env.HOME, manager.environmentFor(account.id).HOME);
});

test('reports authentication from file existence without reading credential content', async (t) => {
  const { manager } = await fixture(t);
  const created = await manager.create('已登录账号');
  const account = created.accounts.find((entry) => entry.label === '已登录账号');
  const authPath = path.join(manager.environmentFor(account.id).GROK_HOME, 'auth.json');
  await fsp.writeFile(authPath, '{not-json-and-never-read}', 'utf8');
  const listed = manager.list().accounts.find((entry) => entry.id === account.id);
  assert.equal(listed.authenticated, true);
  assert.ok(Number.isFinite(listed.authUpdatedAt));
});

test('login completion is surfaced without exposing token-like output', async (t) => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdout.setEncoding = () => undefined;
      this.stderr.setEncoding = () => undefined;
    }
    kill() {}
  }
  let child;
  const { manager } = await fixture(t, {
    spawnImpl: () => {
      child = new FakeChild();
      return child;
    },
  });
  const created = await manager.create('登录测试');
  const account = created.accounts.find((entry) => entry.label === '登录测试');
  await manager.login(account.id, 'device');
  child.stderr.emit('data', 'Visit https://example.test and token mock-provider-secret-value-123456789');
  const authPath = path.join(manager.environmentFor(account.id).GROK_HOME, 'auth.json');
  await fsp.writeFile(authPath, '{}', 'utf8');
  child.emit('exit', 0);
  const status = manager.loginStatus(account.id);
  assert.equal(status.status, 'succeeded');
  assert.doesNotMatch(status.output, /mock-provider-secret/);
});
