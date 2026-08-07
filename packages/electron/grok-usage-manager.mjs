import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 25_000;
const WARM_REFRESH_TIMEOUT_MS = 12_000;
const SESSION_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const clampPercent = (value) => Math.max(0, Math.min(100, value));

const stripTerminalControlSequences = (value) => String(value ?? '')
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

const parseResetAt = (label, now) => {
  if (!label) return null;
  const hasYear = /\b\d{4}\b/.test(label);
  const year = new Date(now).getFullYear();
  const candidates = hasYear ? [label] : [`${label} ${year}`, `${label} ${year + 1}`];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (hasYear || parsed >= now - 24 * 60 * 60 * 1_000) return parsed;
  }
  return null;
};

const firstNumber = (source, patterns) => {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const value = Number.parseFloat(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return null;
};

export const parseGrokUsageOutput = (output, now = Date.now()) => {
  const text = stripTerminalControlSequences(output);
  const weeklyMatch = text.match(/Weekly\s+(?:limit|usage)\s*:\s*(\d+(?:\.\d+)?)\s*%/i);
  const monthlyMatch = text.match(/Monthly\s+(?:limit|usage)\s*:\s*(\d+(?:\.\d+)?)\s*%/i);
  const genericMatch = text.match(/(?:Credit\s+)?usage\s*:\s*(\d+(?:\.\d+)?)\s*%/i);
  const percentMatch = weeklyMatch ?? monthlyMatch ?? genericMatch;
  if (!percentMatch) return null;

  const usedPercent = clampPercent(Number.parseFloat(percentMatch[1]));
  if (!Number.isFinite(usedPercent)) return null;
  const resetMatch = text.match(/Next\s+reset\s*:\s*([^\n\u001b]+)/i);
  const resetLabel = resetMatch?.[1]?.trim().replace(/\s{2,}.*$/, '') || null;
  const creditLimit = firstNumber(text, [
    /(?:Credit|Monthly)\s+limit\s*:\s*([\d,.]+)/i,
    /Total\s+credits\s*:\s*([\d,.]+)/i,
  ]);
  const creditsUsed = firstNumber(text, [
    /Credits?\s+used\s*:\s*([\d,.]+)/i,
    /Used\s+credits?\s*:\s*([\d,.]+)/i,
  ]);
  const creditsRemaining = firstNumber(text, [
    /Credits?\s+remaining\s*:\s*([\d,.]+)/i,
    /Remaining\s+credits?\s*:\s*([\d,.]+)/i,
  ]);

  return {
    period: weeklyMatch ? 'weekly' : monthlyMatch ? 'monthly' : 'unknown',
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetLabel,
    resetAt: parseResetAt(resetLabel, now),
    credits: creditLimit !== null || creditsUsed !== null || creditsRemaining !== null
      ? {
          limit: creditLimit,
          used: creditsUsed,
          remaining: creditsRemaining,
        }
      : null,
  };
};

const parseSessionIds = (output) => new Set(String(output ?? '').match(SESSION_ID_PATTERN) ?? []);

const normalizeEnvironment = (environment) => Object.fromEntries(
  Object.entries(environment).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]),
);

export class GrokUsageManager {
  constructor({
    grokPath,
    accountManager,
    probeDirectory,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    storagePath = null,
    onSnapshot = () => undefined,
    execFileImpl = execFileAsync,
    ptyModuleLoader = () => import('node-pty'),
    now = () => Date.now(),
    log = () => undefined,
  }) {
    if (!grokPath || !accountManager || !probeDirectory) {
      throw new Error('grokPath, accountManager and probeDirectory are required');
    }
    this.grokPath = grokPath;
    this.accountManager = accountManager;
    this.probeDirectory = path.resolve(probeDirectory);
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.storagePath = storagePath ? path.resolve(storagePath) : null;
    this.onSnapshot = onSnapshot;
    this.execFileImpl = execFileImpl;
    this.ptyModuleLoader = ptyModuleLoader;
    this.now = now;
    this.log = log;
    this.cache = new Map();
    this.inFlight = new Map();
    this.worker = null;
    this.persistedLoaded = false;
    this.persistChain = Promise.resolve();
    this.closed = false;
  }

  #runtimeOptions(accountEnvironment, timeout = 20_000) {
    return {
      cwd: this.probeDirectory,
      env: normalizeEnvironment({
        ...process.env,
        ...accountEnvironment,
        GROK_DISABLE_AUTOUPDATER: '1',
      }),
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    };
  }

  async #listProbeSessions(accountEnvironment) {
    const { stdout } = await this.execFileImpl(
      this.grokPath,
      ['sessions', 'list', '--limit', '100'],
      this.#runtimeOptions(accountEnvironment),
    );
    return parseSessionIds(stdout);
  }

  async #cleanupProbeSessions(beforeIds, accountEnvironment) {
    if (!beforeIds) return;
    let afterIds;
    try {
      afterIds = await this.#listProbeSessions(accountEnvironment);
    } catch (error) {
      this.log(`could not list usage-probe sessions for cleanup: ${error.message}`);
      return;
    }
    const createdIds = [...afterIds].filter((id) => !beforeIds.has(id));
    for (const id of createdIds) {
      try {
        await this.execFileImpl(
          this.grokPath,
          ['sessions', 'delete', id],
          this.#runtimeOptions(accountEnvironment),
        );
      } catch (error) {
        this.log(`could not delete usage-probe session ${id}: ${error.message}`);
      }
    }
  }

  async #loadPersistedCache() {
    if (this.persistedLoaded) return;
    this.persistedLoaded = true;
    if (!this.storagePath) return;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.storagePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.accounts || typeof parsed.accounts !== 'object') return;
      for (const [accountId, snapshot] of Object.entries(parsed.accounts)) {
        if (!snapshot || typeof snapshot !== 'object') continue;
        if (!Number.isFinite(snapshot.usedPercent) || !Number.isFinite(snapshot.fetchedAt)) continue;
        this.cache.set(accountId, {
          ...snapshot,
          accountId,
          status: 'stale',
          source: 'grok-official-usage',
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`could not read Grok usage cache: ${error.message}`);
    }
  }

  #persistCache() {
    if (!this.storagePath) return Promise.resolve();
    const accounts = Object.fromEntries([...this.cache.entries()].map(([accountId, snapshot]) => [accountId, {
      period: snapshot.period,
      usedPercent: snapshot.usedPercent,
      remainingPercent: snapshot.remainingPercent,
      resetLabel: snapshot.resetLabel ?? null,
      resetAt: snapshot.resetAt ?? null,
      fetchedAt: snapshot.fetchedAt,
      credits: snapshot.credits ?? null,
    }]));
    const payload = `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`;
    const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await fsp.mkdir(path.dirname(this.storagePath), { recursive: true });
      await fsp.writeFile(temporaryPath, payload, 'utf8');
      await fsp.rename(temporaryPath, this.storagePath);
    });
    return this.persistChain;
  }

  #publish(snapshot) {
    try {
      this.onSnapshot(snapshot);
    } catch (error) {
      this.log(`could not publish Grok usage snapshot: ${error.message}`);
    }
  }

  async #closeWorker({ cleanup = true } = {}) {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    worker.closed = true;
    clearTimeout(worker.startupTimer);
    if (worker.request) {
      clearTimeout(worker.request.timeoutTimer);
      clearTimeout(worker.request.completionTimer);
      worker.request.reject(new Error('Grok usage terminal was restarted'));
      worker.request = null;
    }
    try { worker.child.kill(); } catch {}
    if (cleanup) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await this.#cleanupProbeSessions(worker.beforeIds, worker.accountEnvironment);
    }
  }

  async #ensureWorker(accountId, accountEnvironment) {
    if (this.worker && !this.worker.closed && this.worker.accountId === accountId) return this.worker;
    await this.#closeWorker();
    await fsp.mkdir(this.probeDirectory, { recursive: true });
    let beforeIds = null;
    try {
      beforeIds = await this.#listProbeSessions(accountEnvironment);
    } catch (error) {
      this.log(`could not establish usage-probe session baseline: ${error.message}`);
    }

    const ptyModule = await this.ptyModuleLoader();
    const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
    if (typeof spawnPty !== 'function') throw new Error('Grok usage terminal is unavailable');

    const child = spawnPty(this.grokPath, ['--minimal', '--no-memory', '--no-subagents', '--disable-web-search'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: this.probeDirectory,
      env: normalizeEnvironment({
        ...process.env,
        ...accountEnvironment,
        GROK_DISABLE_AUTOUPDATER: '1',
        TERM: 'xterm-256color',
      }),
      useConpty: process.platform === 'win32',
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = {
      accountId,
      accountEnvironment,
      beforeIds,
      child,
      closed: false,
      ready: false,
      readyPromise,
      request: null,
      startupTimer: null,
    };
    worker.startupTimer = setTimeout(() => {
      rejectReady(new Error('Timed out while starting Grok usage terminal'));
      void this.#closeWorker();
    }, this.timeoutMs);
    worker.startupTimer.unref?.();
    child.onData((chunk) => {
      const text = stripTerminalControlSequences(chunk);
      if (!worker.ready && (
        /minimal\s*·\s*\/help/i.test(text)
        || /\d+(?:\.\d+)?[KMG]?\s*\/\s*\d+(?:\.\d+)?[KMG]?\s*\(\d+%\)/i.test(text)
      )) {
        worker.ready = true;
        clearTimeout(worker.startupTimer);
        resolveReady(worker);
      }
      const request = worker.request;
      if (!request) return;
      request.output = `${request.output}${chunk}`.slice(-200_000);
      if (Date.now() < request.notBefore) return;
      const parsed = parseGrokUsageOutput(request.output, this.now());
      if (!parsed) return;
      clearTimeout(request.completionTimer);
      request.completionTimer = setTimeout(() => {
        if (worker.request !== request) return;
        worker.request = null;
        clearTimeout(request.timeoutTimer);
        request.resolve(parsed);
      }, parsed.resetLabel ? 120 : 450);
      request.completionTimer.unref?.();
    });
    child.onExit(() => {
      if (worker.closed) return;
      worker.closed = true;
      clearTimeout(worker.startupTimer);
      rejectReady(new Error('Grok usage terminal exited before it became ready'));
      if (worker.request) {
        clearTimeout(worker.request.timeoutTimer);
        clearTimeout(worker.request.completionTimer);
        worker.request.reject(new Error('Grok usage terminal exited'));
        worker.request = null;
      }
      if (this.worker === worker) this.worker = null;
      void this.#cleanupProbeSessions(worker.beforeIds, worker.accountEnvironment);
    });
    this.worker = worker;
    await readyPromise;
    return worker;
  }

  async #runOfficialUsageProbe(accountId, accountEnvironment) {
    const worker = await this.#ensureWorker(accountId, accountEnvironment);
    if (worker.request) throw new Error('Grok usage refresh is already running');
    return new Promise((resolve, reject) => {
      const request = {
        output: '',
        notBefore: Date.now() + 180,
        resolve,
        reject,
        completionTimer: null,
        timeoutTimer: null,
      };
      request.timeoutTimer = setTimeout(() => {
        if (worker.request !== request) return;
        worker.request = null;
        reject(new Error('Timed out while reading Grok subscription usage'));
        void this.#closeWorker();
      }, WARM_REFRESH_TIMEOUT_MS);
      request.timeoutTimer.unref?.();
      worker.request = request;
      worker.child.write('/usage\r');
    });
  }

  async get({ force = false } = {}) {
    if (this.closed) throw new Error('Grok usage manager is closed');
    await this.#loadPersistedCache();
    const accountId = this.accountManager.list().currentId;
    const accountEnvironment = typeof this.accountManager.environmentFor === 'function'
      ? this.accountManager.environmentFor(accountId)
      : this.accountManager.activeEnvironment();
    const cached = this.cache.get(accountId);
    const currentTime = this.now();
    if (!force && cached && currentTime - cached.fetchedAt < this.cacheTtlMs) return cached;
    if (!force && cached) {
      void this.#refresh(accountId, accountEnvironment, cached);
      return { ...cached, status: 'stale' };
    }
    return this.#refresh(accountId, accountEnvironment, cached);
  }

  async #refresh(accountId, accountEnvironment, fallbackSnapshot = null) {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;

    const request = (async () => {
      try {
        const parsed = await this.#runOfficialUsageProbe(accountId, accountEnvironment);
        const snapshot = {
          ...parsed,
          accountId,
          fetchedAt: this.now(),
          status: 'ready',
          source: 'grok-official-usage',
        };
        this.cache.set(accountId, snapshot);
        await this.#persistCache().catch((error) => this.log(`could not persist Grok usage cache: ${error.message}`));
        this.#publish(snapshot);
        return snapshot;
      } catch (error) {
        if (fallbackSnapshot) {
          const stale = {
            ...fallbackSnapshot,
            status: 'stale',
            refreshError: error instanceof Error ? error.message : String(error),
          };
          this.#publish(stale);
          return stale;
        }
        throw error;
      } finally {
        this.inFlight.delete(accountId);
      }
    })();
    this.inFlight.set(accountId, request);
    return request;
  }

  async prewarm() {
    if (this.closed) return;
    await this.#loadPersistedCache();
    const accountId = this.accountManager.list().currentId;
    const accountEnvironment = typeof this.accountManager.environmentFor === 'function'
      ? this.accountManager.environmentFor(accountId)
      : this.accountManager.activeEnvironment();
    await this.#refresh(accountId, accountEnvironment, this.cache.get(accountId) ?? null);
  }

  async invalidate(accountId = null) {
    if (accountId) this.cache.delete(accountId);
    else this.cache.clear();
    await this.#closeWorker();
  }

  async close() {
    this.closed = true;
    await this.#closeWorker();
    await Promise.allSettled(this.inFlight.values());
    this.inFlight.clear();
    await this.persistChain.catch(() => undefined);
  }
}

export const createGrokUsageManager = (options) => new GrokUsageManager(options);
