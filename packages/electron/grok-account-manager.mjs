import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REGISTRY_VERSION = 1;
const DEFAULT_ACCOUNT_ID = 'default';
const MAX_OUTPUT_CHARS = 4_000;

const now = () => Date.now();

const sanitizeLabel = (value) => {
  const label = String(value ?? '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!label) throw new Error('账号名称不能为空');
  if (label.length > 60) throw new Error('账号名称不能超过 60 个字符');
  return label;
};

const sanitizeProcessOutput = (value) => String(value ?? '')
  .replace(/xai-[A-Za-z0-9_-]{12,}/g, '[redacted]')
  .replace(/\beyJ[A-Za-z0-9._-]{40,}\b/g, '[redacted]')
  .slice(-MAX_OUTPUT_CHARS);

const atomicWriteJson = async (filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, filePath);
};

const isAccountRecord = (value) => (
  value
  && typeof value === 'object'
  && typeof value.id === 'string'
  && typeof value.label === 'string'
  && (value.kind === 'system' || value.kind === 'isolated')
  && Number.isFinite(value.createdAt)
);

class GrokAccountManager {
  constructor({
    storageRoot,
    grokPath,
    defaultHome,
    onActiveAccountChanging,
    spawnImpl = spawn,
    execFileImpl = execFileAsync,
  }) {
    if (!storageRoot || !grokPath || !defaultHome) {
      throw new Error('storageRoot, grokPath and defaultHome are required');
    }
    this.storageRoot = path.resolve(storageRoot);
    this.registryPath = path.join(this.storageRoot, 'accounts.json');
    this.profilesRoot = path.join(this.storageRoot, 'profiles');
    this.grokPath = grokPath;
    this.defaultHome = path.resolve(defaultHome);
    this.onActiveAccountChanging = onActiveAccountChanging ?? (async () => undefined);
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.accounts = [];
    this.currentId = DEFAULT_ACCOUNT_ID;
    this.loginJobs = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    await fsp.mkdir(this.profilesRoot, { recursive: true });
    let persisted = null;
    try {
      persisted = JSON.parse(await fsp.readFile(this.registryPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt metadata must not block Grok; start from the system account.
        persisted = null;
      }
    }
    const persistedAccounts = Array.isArray(persisted?.accounts)
      ? persisted.accounts.filter(isAccountRecord)
      : [];
    const defaultAccount = {
      id: DEFAULT_ACCOUNT_ID,
      label: '系统默认账号',
      kind: 'system',
      createdAt: persistedAccounts.find((entry) => entry.id === DEFAULT_ACCOUNT_ID)?.createdAt ?? now(),
      lastUsedAt: persistedAccounts.find((entry) => entry.id === DEFAULT_ACCOUNT_ID)?.lastUsedAt ?? null,
    };
    const isolated = persistedAccounts.filter((entry) => (
      entry.id !== DEFAULT_ACCOUNT_ID
      && entry.kind === 'isolated'
      && /^[a-z0-9-]{8,80}$/.test(entry.id)
    )).map((entry) => ({
      id: entry.id,
      label: sanitizeLabel(entry.label),
      kind: 'isolated',
      createdAt: entry.createdAt,
      lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : null,
    }));
    this.accounts = [defaultAccount, ...isolated];
    this.currentId = this.accounts.some((entry) => entry.id === persisted?.currentId)
      ? persisted.currentId
      : DEFAULT_ACCOUNT_ID;
    await this.#persist();
  }

  #account(id) {
    const account = this.accounts.find((entry) => entry.id === id);
    if (!account) throw new Error('找不到该 Grok 账号档案');
    return account;
  }

  #profileHome(account) {
    return account.kind === 'system'
      ? this.defaultHome
      : path.join(this.profilesRoot, account.id, 'home');
  }

  #authPath(account) {
    return path.join(this.#profileHome(account), '.grok', 'auth.json');
  }

  #authStatus(account) {
    const authPath = this.#authPath(account);
    let stat = null;
    try {
      stat = fs.statSync(authPath);
    } catch {
    }
    return {
      authenticated: Boolean(stat?.isFile()),
      authUpdatedAt: stat?.isFile() ? stat.mtimeMs : null,
    };
  }

  environmentFor(id = this.currentId) {
    const account = this.#account(id);
    if (account.kind === 'system') return {};
    const home = this.#profileHome(account);
    return {
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: path.join(home, '.grok'),
    };
  }

  activeEnvironment() {
    return this.environmentFor(this.currentId);
  }

  homeFor(id = this.currentId) {
    return this.#profileHome(this.#account(id));
  }

  activeHome() {
    return this.homeFor(this.currentId);
  }

  grokHomeFor(id = this.currentId) {
    const environment = this.environmentFor(id);
    return environment.GROK_HOME || path.join(this.homeFor(id), '.grok');
  }

  activeGrokHome() {
    return this.grokHomeFor(this.currentId);
  }

  list() {
    return {
      currentId: this.currentId,
      accounts: this.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        kind: account.kind,
        active: account.id === this.currentId,
        createdAt: account.createdAt,
        lastUsedAt: account.lastUsedAt ?? null,
        ...this.#authStatus(account),
        login: this.loginStatus(account.id),
      })),
    };
  }

  async create(label) {
    await this.load();
    const id = `acct-${randomUUID()}`;
    const account = {
      id,
      label: sanitizeLabel(label),
      kind: 'isolated',
      createdAt: now(),
      lastUsedAt: null,
    };
    await fsp.mkdir(path.join(this.#profileHome(account), '.grok'), { recursive: true });
    this.accounts.push(account);
    await this.#persist();
    return this.list();
  }

  async rename(id, label) {
    await this.load();
    const account = this.#account(id);
    account.label = sanitizeLabel(label);
    await this.#persist();
    return this.list();
  }

  async switch(id) {
    await this.load();
    if (id === this.currentId) return this.list();
    const account = this.#account(id);
    if (this.loginJobs.get(id)?.status === 'running') {
      throw new Error('该账号仍在登录中，完成或取消登录后再切换');
    }
    await this.onActiveAccountChanging(account, this.environmentFor(id));
    this.currentId = id;
    account.lastUsedAt = now();
    await this.#persist();
    return this.list();
  }

  loginStatus(id) {
    const job = this.loginJobs.get(id);
    if (!job) return { status: 'idle', output: '', startedAt: null, completedAt: null };
    return {
      status: job.status,
      output: job.output,
      startedAt: job.startedAt,
      completedAt: job.completedAt ?? null,
      exitCode: Number.isInteger(job.exitCode) ? job.exitCode : null,
    };
  }

  async login(id, method = 'oauth') {
    await this.load();
    const account = this.#account(id);
    const existing = this.loginJobs.get(id);
    if (existing?.status === 'running') return this.loginStatus(id);
    const normalizedMethod = method === 'device' ? 'device' : 'oauth';
    const args = ['login', normalizedMethod === 'device' ? '--device-auth' : '--oauth'];
    const home = this.#profileHome(account);
    await fsp.mkdir(path.join(home, '.grok'), { recursive: true });
    const child = this.spawnImpl(this.grokPath, args, {
      cwd: home,
      env: {
        ...process.env,
        ...this.environmentFor(id),
        GROK_DISABLE_AUTOUPDATER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: normalizedMethod === 'oauth',
    });
    const job = {
      status: 'running',
      output: normalizedMethod === 'oauth' ? '正在浏览器中打开 Grok 登录页面…' : '正在获取设备登录代码…',
      startedAt: now(),
      completedAt: null,
      exitCode: null,
      child,
    };
    this.loginJobs.set(id, job);
    const appendOutput = (chunk) => {
      job.output = sanitizeProcessOutput(`${job.output}\n${String(chunk ?? '')}`);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', appendOutput);
    child.stderr?.on?.('data', appendOutput);
    child.on('error', (error) => {
      job.status = 'failed';
      job.output = sanitizeProcessOutput(`${job.output}\n${error.message}`);
      job.completedAt = now();
    });
    child.on('exit', (code) => {
      job.exitCode = code;
      job.completedAt = now();
      const authenticated = this.#authStatus(account).authenticated;
      job.status = code === 0 && authenticated ? 'succeeded' : 'failed';
      if (job.status === 'succeeded') {
        job.output = '登录成功。切换到该账号后，新会话将使用此登录。';
        if (id === this.currentId) {
          void Promise.resolve(this.onActiveAccountChanging(account, this.environmentFor(id))).catch((error) => {
            job.status = 'failed';
            job.output = sanitizeProcessOutput(`登录已保存，但 Grok 运行时刷新失败：${error?.message ?? error}`);
          });
        }
      } else if (!job.output.trim()) {
        job.output = '登录未完成。请重试或改用设备码登录。';
      }
    });
    return this.loginStatus(id);
  }

  async logout(id) {
    await this.load();
    const account = this.#account(id);
    if (this.loginJobs.get(id)?.status === 'running') {
      throw new Error('账号仍在登录中，暂时不能退出');
    }
    await this.execFileImpl(this.grokPath, ['logout'], {
      cwd: this.#profileHome(account),
      env: {
        ...process.env,
        ...this.environmentFor(id),
        GROK_DISABLE_AUTOUPDATER: '1',
      },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (id === this.currentId) {
      await this.onActiveAccountChanging(account, this.environmentFor(id));
    }
    return this.list();
  }

  async remove(id) {
    await this.load();
    const account = this.#account(id);
    if (account.kind === 'system') throw new Error('系统默认账号不能删除');
    if (this.loginJobs.get(id)?.status === 'running') throw new Error('账号仍在登录中，暂时不能删除');
    if (id === this.currentId) await this.switch(DEFAULT_ACCOUNT_ID);
    this.accounts = this.accounts.filter((entry) => entry.id !== id);
    await fsp.rm(path.join(this.profilesRoot, id), { recursive: true, force: true });
    await this.#persist();
    return this.list();
  }

  async close() {
    for (const job of this.loginJobs.values()) {
      if (job.status !== 'running') continue;
      try { job.child?.kill?.(); } catch {
      }
    }
  }

  async #persist() {
    await atomicWriteJson(this.registryPath, {
      version: REGISTRY_VERSION,
      currentId: this.currentId,
      accounts: this.accounts.map(({ id, label, kind, createdAt, lastUsedAt }) => ({
        id,
        label,
        kind,
        createdAt,
        lastUsedAt: lastUsedAt ?? null,
      })),
    });
  }
}

export const createGrokAccountManager = (options) => new GrokAccountManager(options);
