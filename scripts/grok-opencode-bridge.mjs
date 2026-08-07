#!/usr/bin/env node

import { execFile, spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  localizeGrokAgentDescription,
  localizeGrokSessionTitle,
  localizeGrokSkillDescription,
  normalizeGrokCommands,
} from './grok-localization.mjs';

const __filename = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);

const DEFAULT_GROK_PATH = process.platform === 'win32' ? 'grok.exe' : 'grok';

const MODEL_ID = 'grok-build';
const PROVIDER_ID = 'xai';
const BRIDGE_VERSION = '0.1.0';
const PERSISTENCE_VERSION = 1;
const DISCOVERY_CACHE_TTL_MS = 5_000;
const NATIVE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCEL_RESEND_DELAY_MS = 750;
const CANCEL_FORCE_CLOSE_DELAY_MS = 3_000;

const now = () => Date.now();
const makeId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const normalizeDirectory = (value, fallback = process.cwd()) => path.resolve(
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback,
);
const projectIdFor = (directory) => `pro_${createHash('sha1').update(directory.toLowerCase()).digest('hex').slice(0, 20)}`;
const projectNameFor = (directory) => path.basename(directory) || directory;

const parseGrokJson = (text) => {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch (firstError) {
    // Grok 0.2.x can emit raw Windows paths with one backslash in a few
    // inspect fields. Repair only invalid JSON escapes; keep valid escapes
    // and all ordinary content byte-for-byte equivalent.
    const repaired = normalized.replace(/(?<!\\)\\(?![\\"/bfnrtu])/g, '\\\\');
    try {
      return JSON.parse(repaired);
    } catch {
      throw firstError;
    }
  }
};

const runGrokJsonCommand = (grokPath, args, cwd, env = {}) => {
  const output = execFileSync(grokPath, args, {
    cwd,
    env: { ...process.env, ...env, GROK_DISABLE_AUTOUPDATER: '1' },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseGrokJson(output);
};

const runGrokCommand = async (grokPath, args, cwd, timeout = 120_000, env = {}) => {
  const { stdout, stderr } = await execFileAsync(grokPath, args, {
    cwd,
    env: { ...process.env, ...env, GROK_DISABLE_AUTOUPDATER: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() };
};

const jsonResponse = (res, status, body) => {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
};

const emptyResponse = (res, status = 204) => {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
};

const contentText = (value) => {
  if (typeof value === 'string') return value;
  if (!value) return '';
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.content) return contentText(value.content);
    if (typeof value.output === 'string') return value.output;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const createModel = () => ({
  id: MODEL_ID,
  providerID: PROVIDER_ID,
  api: {
    id: MODEL_ID,
    url: 'local://grok-acp',
    npm: 'grok-build',
  },
  name: 'Grok Build',
  family: 'grok',
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: true,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, input: 200_000, output: 32_768 },
  status: 'active',
  options: {},
  headers: {},
  release_date: '2026-01-01',
  variants: {
    low: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high' },
    xhigh: { reasoningEffort: 'xhigh' },
  },
});

const createProvider = () => ({
  id: PROVIDER_ID,
  name: 'Grok Build',
  source: 'api',
  env: [],
  options: {},
  models: { [MODEL_ID]: createModel() },
});

const createAgent = (name, description, mode = 'primary', native = true) => ({
  name,
  description,
  mode,
  native,
  hidden: false,
  permission: [],
  model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
  options: {},
});

export const buildSessionCancelNotification = (sessionId, promptRequestId = null) => ({
  jsonrpc: '2.0',
  method: 'session/cancel',
  params: {
    sessionId,
    reason: 'user',
    _meta: {
      cancelSubagents: true,
      cancelTrigger: 'mouse',
      ...(promptRequestId !== null ? { cancelPromptId: String(promptRequestId) } : {}),
    },
  },
});

class GrokAcpClient {
  constructor({ grokPath, cwd, rules, resumeSessionId, mcpServers = [], env = {}, onInitialize, onUpdate, onPermission, onExit, log }) {
    this.grokPath = grokPath;
    this.cwd = cwd;
    this.rules = rules;
    this.resumeSessionId = resumeSessionId ?? null;
    this.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];
    this.env = env && typeof env === 'object' ? { ...env } : {};
    this.onInitialize = onInitialize;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.onExit = onExit;
    this.log = log;
    this.process = null;
    this.input = null;
    this.nextId = 1;
    this.pending = new Map();
    this.acpSessionId = null;
    this.closed = false;
    this.activePromptRequestId = null;
    this.cancelResendTimer = null;
    this.cancelForceCloseTimer = null;
  }

  async start() {
    if (this.process) return;
    const child = spawn(this.grokPath, ['agent', '--no-leader', 'stdio'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, GROK_DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    this.input = child.stdin;
    this.input.setDefaultEncoding('utf8');

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log?.(`Grok: ${text}`);
    });
    child.on('error', (error) => this.#handleExit(error));
    child.on('exit', (code, signal) => this.#handleExit(new Error(`Grok ACP exited: code=${code ?? 'null'} signal=${signal ?? 'none'}`)));

    const initializeResult = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Grok Code Desktop', version: BRIDGE_VERSION },
    });
    this.onInitialize?.(initializeResult);
    const sessionParams = {
      cwd: this.cwd,
      mcpServers: this.mcpServers,
      _meta: {
        rules: this.rules,
        autoMode: false,
      },
    };
    if (this.resumeSessionId) {
      await this.request('session/load', {
        ...sessionParams,
        sessionId: this.resumeSessionId,
      });
      this.acpSessionId = this.resumeSessionId;
    } else {
      const result = await this.request('session/new', sessionParams);
      this.acpSessionId = result?.sessionId;
    }
    if (!this.acpSessionId) throw new Error('Grok ACP session initialization returned no sessionId');
  }

  request(method, params) {
    if (this.closed || !this.input) return Promise.reject(new Error('Grok ACP client is closed'));
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    if (method === 'session/prompt') this.activePromptRequestId = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.#send(message);
    });
  }

  notify(method, params) {
    if (this.closed || !this.input) return false;
    this.#send({ jsonrpc: '2.0', method, params });
    return true;
  }

  respond(id, result) {
    if (this.closed) return;
    this.#send({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    if (this.closed) return;
    this.#send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  #send(message) {
    this.input.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log?.('Ignored non-JSON Grok ACP output');
      return;
    }

    if (message.id !== undefined && message.method) {
      if (message.method === 'session/request_permission') {
        this.onPermission?.({
          rpcId: message.id,
          params: message.params ?? {},
          respond: (result) => this.respond(message.id, result),
        });
      } else {
        this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
      }
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.method === 'session/prompt' && this.activePromptRequestId === message.id) {
        this.activePromptRequestId = null;
        this.#clearCancelTimers();
      }
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (message.method === 'session/update' || message.method === 'x.ai/session/update') {
      const update = message.params?.update ?? message.params?.sessionUpdate;
      if (update) this.onUpdate?.(update);
    }
  }

  #handleExit(error) {
    if (this.closed) return;
    this.closed = true;
    this.activePromptRequestId = null;
    this.#clearCancelTimers();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onExit?.(error);
  }

  #clearCancelTimers() {
    if (this.cancelResendTimer) clearTimeout(this.cancelResendTimer);
    if (this.cancelForceCloseTimer) clearTimeout(this.cancelForceCloseTimer);
    this.cancelResendTimer = null;
    this.cancelForceCloseTimer = null;
  }

  cancel() {
    if (!this.acpSessionId || this.closed) return false;
    const promptRequestId = this.activePromptRequestId;
    const notification = buildSessionCancelNotification(this.acpSessionId, promptRequestId);
    this.notify(notification.method, notification.params);
    if (promptRequestId !== null) {
      this.notify('$/cancel_request', { id: promptRequestId });
    }
    this.#clearCancelTimers();
    this.cancelResendTimer = setTimeout(() => {
      if (this.closed || this.activePromptRequestId === null) return;
      const retry = buildSessionCancelNotification(this.acpSessionId, this.activePromptRequestId);
      this.notify(retry.method, retry.params);
    }, CANCEL_RESEND_DELAY_MS);
    this.cancelResendTimer.unref?.();
    this.cancelForceCloseTimer = setTimeout(() => {
      if (this.closed || this.activePromptRequestId === null) return;
      this.close('Grok ACP turn cancelled after timeout');
    }, CANCEL_FORCE_CLOSE_DELAY_MS);
    this.cancelForceCloseTimer.unref?.();
    return true;
  }

  close(reason = 'Grok ACP client closed') {
    if (this.closed) return;
    this.closed = true;
    this.activePromptRequestId = null;
    this.#clearCancelTimers();
    try { this.input?.end(); } catch {
    }
    try { this.process?.kill(); } catch {
    }
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}

class GrokOpenCodeBridge {
  constructor(options = {}) {
    this.grokPath = options.grokPath ?? process.env.GROK_BINARY ?? DEFAULT_GROK_PATH;
    this.defaultDirectory = normalizeDirectory(options.defaultDirectory ?? process.env.GROK_DEFAULT_DIRECTORY ?? process.cwd());
    this.rules = options.rules ?? '默认使用简体中文回答。像成熟代码代理一样先理解项目，再执行最小必要修改；清晰展示计划、命令、文件变更和验证结果。';
    this.log = options.log ?? ((message) => console.log(`[grok-bridge] ${message}`));
    this.stateFile = options.stateFile === null
      ? null
      : options.stateFile ?? path.join(homedir(), '.grok', 'grok-code-desktop-sessions.json');
    this.grokEnv = options.grokEnv && typeof options.grokEnv === 'object' ? { ...options.grokEnv } : {};
    this.activeAccountId = typeof options.activeAccountId === 'string' ? options.activeAccountId : 'default';
    this.acpClientFactory = options.acpClientFactory ?? ((clientOptions) => new GrokAcpClient(clientOptions));
    this.inspectRunner = options.inspectRunner ?? ((directory) => runGrokJsonCommand(this.grokPath, ['inspect', '--json'], directory, this.grokEnv));
    this.worktreeRunner = options.worktreeRunner ?? ((directory) => runGrokJsonCommand(this.grokPath, ['worktree', 'list', '--json', '--all'], directory, this.grokEnv));
    this.mcpDoctorRunner = options.mcpDoctorRunner ?? ((name, directory) => runGrokJsonCommand(this.grokPath, ['mcp', 'doctor', '--json', name], directory, this.grokEnv));
    this.availablePluginsRunner = options.availablePluginsRunner ?? ((directory) => runGrokJsonCommand(this.grokPath, ['plugin', 'list', '--json', '--available'], directory, this.grokEnv));
    this.pluginInstallRunner = options.pluginInstallRunner ?? ((spec, directory) => runGrokCommand(this.grokPath, ['plugin', 'install', spec, '--trust'], directory, 120_000, this.grokEnv));
    this.pluginUpdateRunner = options.pluginUpdateRunner ?? ((name, directory) => runGrokCommand(this.grokPath, ['plugin', 'update', name], directory, 120_000, this.grokEnv));
    this.pluginUninstallRunner = options.pluginUninstallRunner ?? ((name, directory) => runGrokCommand(this.grokPath, ['plugin', 'uninstall', name], directory, 120_000, this.grokEnv));
    this.nativeSessionLoader = typeof options.nativeSessionLoader === 'function'
      ? options.nativeSessionLoader
      : null;
    this.nativeCommands = normalizeGrokCommands([
      { name: 'compact' },
      { name: 'always-approve' },
      { name: 'context' },
      { name: 'session-info' },
      { name: 'deep-research' },
      { name: 'workflow' },
      { name: 'goal' },
    ]);
    this.browserController = options.browserController ?? null;
    this.browserMcpScript = options.browserMcpScript ?? null;
    this.browserMcpExecutable = options.browserMcpExecutable ?? process.execPath;
    this.browserControlToken = randomUUID().replaceAll('-', '');
    this.listenOrigin = null;
    this.discoveryCache = new Map();
    this.sessions = new Map();
    this.messages = new Map();
    this.status = new Map();
    this.permissions = new Map();
    this.sseClients = new Set();
    this.eventSequence = 0;
    this.server = null;
    this.heartbeat = null;
    this.persistenceRevision = 0;
    this.persistenceChain = Promise.resolve();
    this.hydrated = false;
  }

  async #inspect(directory, { force = false } = {}) {
    const normalized = normalizeDirectory(directory, this.defaultDirectory);
    const cached = this.discoveryCache.get(normalized);
    if (!force && cached?.value && now() - cached.loadedAt < DISCOVERY_CACHE_TTL_MS) {
      return cached.value;
    }
    if (cached?.inFlight) return cached.inFlight;

    const inFlight = Promise.resolve().then(() => this.inspectRunner(normalized)).then((value) => {
      if (!value || typeof value !== 'object') {
        throw new Error('Grok inspect returned an invalid payload');
      }
      this.discoveryCache.set(normalized, { value, loadedAt: now(), inFlight: null });
      return value;
    }).catch((error) => {
      if (cached?.value) {
        this.log(`Grok discovery refresh failed; preserving previous snapshot: ${error.message}`);
        this.discoveryCache.set(normalized, { value: cached.value, loadedAt: cached.loadedAt, inFlight: null });
        return cached.value;
      }
      this.discoveryCache.delete(normalized);
      throw error;
    });
    this.discoveryCache.set(normalized, { value: cached?.value ?? null, loadedAt: cached?.loadedAt ?? 0, inFlight });
    return inFlight;
  }

  #skillList(inspect) {
    return (Array.isArray(inspect?.skills) ? inspect.skills : []).flatMap((skill) => {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
      if (!name) return [];
      const location = typeof skill?.source?.path === 'string' && skill.source.path.trim()
        ? skill.source.path
        : '<built-in>';
      return [{
        name,
        description: localizeGrokSkillDescription(name, skill.description),
        location,
        content: '',
      }];
    });
  }

  #agentList(inspect) {
    const agents = new Map([
      ['build', createAgent('build', 'Grok 编码与执行代理')],
      ['plan', createAgent('plan', 'Grok 只读规划代理')],
    ]);
    for (const agent of Array.isArray(inspect?.agents) ? inspect.agents : []) {
      const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
      if (!name || agents.has(name)) continue;
      agents.set(name, createAgent(
        name,
        localizeGrokAgentDescription(name, agent.description),
        'subagent',
        agent?.source?.type === 'builtin',
      ));
    }
    return [...agents.values()];
  }

  #mcpStatus(inspect) {
    const result = {};
    for (const server of Array.isArray(inspect?.mcpServers) ? inspect.mcpServers : []) {
      const name = typeof server?.name === 'string' ? server.name.trim() : '';
      if (!name) continue;
      const compatibility = String(server.compatibilityStatus ?? 'enabled').toLowerCase();
      if (compatibility.includes('disable')) {
        result[name] = { status: 'disabled' };
      } else if (compatibility.includes('fail') || compatibility.includes('error') || compatibility.includes('invalid')) {
        result[name] = { status: 'failed', error: `Grok compatibility status: ${server.compatibilityStatus}` };
      } else {
        result[name] = { status: 'connected' };
      }
    }
    return result;
  }

  #pluginList(inspect) {
    return (Array.isArray(inspect?.plugins) ? inspect.plugins : []).flatMap((plugin) => {
      const name = typeof plugin?.name === 'string' ? plugin.name.trim() : '';
      if (!name) return [];
      return [{
        name,
        scope: typeof plugin.scope === 'string' ? plugin.scope : 'user',
        path: typeof plugin.path === 'string' ? plugin.path : '',
        enabled: plugin.enabled !== false,
        provides: plugin.provides && typeof plugin.provides === 'object' ? plugin.provides : {},
        source: 'grok-inspect',
        readOnly: true,
      }];
    });
  }

  #marketplacePluginList(value, query = '') {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    return (Array.isArray(value) ? value : []).flatMap((plugin) => {
      const name = typeof plugin?.name === 'string' ? plugin.name.trim() : '';
      const marketplace = typeof plugin?.marketplace === 'string' ? plugin.marketplace.trim() : '';
      if (!name || !marketplace || plugin?.status === 'installed') return [];
      const description = typeof plugin.description === 'string' ? plugin.description : '';
      const haystack = `${name}\n${marketplace}\n${description}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return [];
      const components = plugin.components && typeof plugin.components === 'object' ? plugin.components : {};
      const count = (key) => Array.isArray(components[key]) ? components[key].length : 0;
      return [{
        name,
        marketplace,
        spec: `${name}@${marketplace}`,
        version: typeof plugin.version === 'string' ? plugin.version : null,
        description,
        counts: {
          skills: count('skills'),
          commands: count('commands'),
          agents: count('agents'),
          mcpServers: count('mcpServers'),
          hooks: count('hooks'),
        },
      }];
    }).slice(0, 200);
  }

  #capabilitySummary(inspect) {
    const skills = this.#skillList(inspect);
    const agents = this.#agentList(inspect);
    const plugins = this.#pluginList(inspect);
    const mcp = this.#mcpStatus(inspect);
    return {
      version: typeof inspect?.grokVersion === 'string' ? inspect.grokVersion : null,
      projectTrusted: inspect?.projectTrusted === true,
      counts: {
        agents: agents.length,
        skills: skills.length,
        plugins: plugins.length,
        mcpServers: Object.keys(mcp).length,
      },
      features: {
        backgroundSubagents: true,
        worktrees: true,
        skills: true,
        mcp: true,
        plugins: true,
        scheduledTasks: true,
        browser: true,
        computerUse: Boolean(this.browserController),
        appshots: Boolean(this.browserController),
        recordReplay: Boolean(this.browserController),
      },
    };
  }

  #browserMcpServers() {
    if (!this.browserController || !this.browserMcpScript || !this.listenOrigin) return [];
    return [{
      name: 'grok-code-browser',
      command: this.browserMcpExecutable,
      args: [this.browserMcpScript],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'GROK_CODE_BROWSER_CONTROL_URL', value: `${this.listenOrigin}/grok/browser/tool` },
        { name: 'GROK_CODE_BROWSER_CONTROL_TOKEN', value: this.browserControlToken },
      ],
    }];
  }

  async listen({ port = 4097, host = '127.0.0.1' } = {}) {
    if (this.server) throw new Error('Bridge is already listening');
    await this.#hydrate();
    this.server = createServer((req, res) => {
      this.#handleRequest(req, res).catch((error) => {
        this.log(`request failed: ${error.stack || error}`);
        if (!res.headersSent) jsonResponse(res, 500, { error: String(error.message || error) });
        else res.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.sseClients) {
        try { client.res.write(': heartbeat\n\n'); } catch {
        }
      }
    }, 15_000);
    this.heartbeat.unref?.();
    const address = this.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.listenOrigin = `http://${host}:${actualPort}`;
    return { host, port: actualPort };
  }

  async close() {
    await this.#persistSnapshot().catch((error) => {
      this.log(`session persistence failed during shutdown: ${error.message}`);
    });
    await this.persistenceChain.catch(() => undefined);
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const state of this.sessions.values()) state.acp?.close();
    for (const client of this.sseClients) {
      try { client.res.end(); } catch {
      }
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.listenOrigin = null;
  }

  async switchGrokAccount({ accountId = 'default', env = {} } = {}) {
    const busySessions = [...this.sessions.values()].filter((state) => state.pendingPromise || state.activeTurn);
    if (busySessions.length > 0) {
      throw new Error('仍有 Grok 会话正在运行，请等待当前回复完成后再切换账号');
    }
    this.grokEnv = env && typeof env === 'object' ? { ...env } : {};
    this.activeAccountId = String(accountId || 'default');
    this.discoveryCache.clear();
    for (const state of this.sessions.values()) {
      const acp = state.acp;
      state.acp = null;
      state.acpSessionId = state.nativeSessionId && state.sourceAccountId === this.activeAccountId
        ? state.nativeSessionId
        : null;
      state.acpStartPromise = null;
      state.activeTurn = null;
      state.pendingPromise = null;
      acp?.close();
      this.#setStatus(state, { type: 'idle' });
    }
    await this.#persistSnapshot();
  }

  #snapshot() {
    return {
      version: PERSISTENCE_VERSION,
      sessions: [...this.sessions.values()].map((state) => ({
        id: state.id,
        acpSessionId: state.acpSessionId ?? state.acp?.acpSessionId ?? null,
        nativeSessionId: state.nativeSessionId ?? null,
        sourceAccountId: state.sourceAccountId ?? null,
        directory: state.directory,
        title: state.title,
        agent: state.agent,
        time: { ...state.time },
        messages: this.#messageRecords(state.id),
      })),
    };
  }

  #isPersistedSession(value) {
    if (!value || typeof value !== 'object') return false;
    if (typeof value.id !== 'string' || !value.id.startsWith('ses_')) return false;
    if (typeof value.directory !== 'string' || value.directory.trim().length === 0) return false;
    if (typeof value.title !== 'string' || typeof value.agent !== 'string') return false;
    if (!value.time || typeof value.time !== 'object') return false;
    if (!Number.isFinite(value.time.created) || !Number.isFinite(value.time.updated)) return false;
    if (value.acpSessionId !== null && value.acpSessionId !== undefined && typeof value.acpSessionId !== 'string') return false;
    if (value.nativeSessionId !== null && value.nativeSessionId !== undefined && typeof value.nativeSessionId !== 'string') return false;
    if (value.sourceAccountId !== null && value.sourceAccountId !== undefined && typeof value.sourceAccountId !== 'string') return false;
    if (!Array.isArray(value.messages)) return false;
    return value.messages.every((record) => (
      record
      && typeof record === 'object'
      && record.info
      && typeof record.info === 'object'
      && Array.isArray(record.parts)
    ));
  }

  async #hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    if (!this.stateFile) return;

    let raw;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`failed to read persisted sessions: ${error.message}`);
      return;
    }

    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (error) {
      this.log(`ignored malformed persisted session snapshot: ${error.message}`);
      return;
    }
    if (
      !snapshot
      || typeof snapshot !== 'object'
      || snapshot.version !== PERSISTENCE_VERSION
      || !Array.isArray(snapshot.sessions)
      || !snapshot.sessions.every((entry) => this.#isPersistedSession(entry))
    ) {
      this.log('ignored invalid persisted session snapshot');
      return;
    }

    for (const entry of snapshot.sessions) {
      const state = {
        id: entry.id,
        acpSessionId: entry.acpSessionId ?? null,
        nativeSessionId: entry.nativeSessionId ?? null,
        sourceAccountId: entry.sourceAccountId ?? null,
        directory: normalizeDirectory(entry.directory, this.defaultDirectory),
        title: entry.title,
        agent: entry.agent,
        time: { created: entry.time.created, updated: entry.time.updated, ...(entry.time.archived ? { archived: entry.time.archived } : {}) },
        acp: null,
        acpStartPromise: null,
        activeTurn: null,
        pendingPromise: null,
        cancelRequestedAt: null,
        nativeTranscriptLoaded: entry.messages.length > 0 || !entry.nativeSessionId,
      };
      this.sessions.set(state.id, state);
      this.messages.set(state.id, entry.messages);
      this.status.set(state.id, { type: 'idle' });
    }
    this.log(`restored ${snapshot.sessions.length} persisted Grok Code session(s)`);
  }

  #persistSnapshot() {
    if (!this.stateFile) return Promise.resolve();
    const revision = ++this.persistenceRevision;
    const payload = `${JSON.stringify(this.#snapshot(), null, 2)}\n`;
    const tempFile = `${this.stateFile}.${process.pid}.${revision}.tmp`;

    this.persistenceChain = this.persistenceChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      await writeFile(tempFile, payload, 'utf8');
      await rename(tempFile, this.stateFile);
    });
    return this.persistenceChain;
  }

  #event(type, properties, directory) {
    const payload = { id: `evt_${++this.eventSequence}`, type, properties };
    const envelope = JSON.stringify({ directory, payload });
    for (const client of this.sseClients) {
      if (client.directory && normalizeDirectory(client.directory) !== normalizeDirectory(directory)) continue;
      try {
        client.res.write(`id: ${payload.id}\n`);
        client.res.write(`data: ${envelope}\n\n`);
      } catch {
        this.sseClients.delete(client);
      }
    }
    return payload;
  }

  #sessionInfo(state) {
    return {
      id: state.id,
      slug: state.id,
      projectID: projectIdFor(state.directory),
      directory: state.directory,
      title: state.title,
      agent: state.agent,
      model: { id: MODEL_ID, providerID: PROVIDER_ID },
      version: `grok-acp-${BRIDGE_VERSION}`,
      metadata: {
        engine: 'grok-acp',
        ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
        ...(state.sourceAccountId ? { sourceAccountId: state.sourceAccountId } : {}),
      },
      time: { ...state.time },
    };
  }

  #project(directory) {
    const normalized = normalizeDirectory(directory, this.defaultDirectory);
    const timestamp = now();
    return {
      id: projectIdFor(normalized),
      worktree: normalized,
      vcs: this.#gitBranch(normalized) !== null ? 'git' : undefined,
      name: projectNameFor(normalized),
      time: { created: timestamp, updated: timestamp },
      sandboxes: [],
    };
  }

  #gitBranch(directory) {
    try {
      return execFileSync('git', ['branch', '--show-current'], {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined;
    } catch {
      return null;
    }
  }

  #gitDiff(directory) {
    try {
      const names = execFileSync('git', ['diff', '--name-only'], {
        cwd: directory,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      return names.map((file) => {
        const patch = execFileSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', file], {
          cwd: directory,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const additions = (patch.match(/^\+(?!\+)/gm) ?? []).length;
        const deletions = (patch.match(/^-(?!--)/gm) ?? []).length;
        return { file, patch, additions, deletions, status: 'modified' };
      });
    } catch {
      return [];
    }
  }

  #createAcpClient(state) {
    return this.acpClientFactory({
      grokPath: this.grokPath,
      cwd: state.directory,
      rules: this.rules,
      resumeSessionId: state.nativeSessionId ?? state.acpSessionId,
      mcpServers: this.#browserMcpServers(),
      env: this.grokEnv,
      log: this.log,
      onInitialize: (result) => {
        const commands = normalizeGrokCommands(result?._meta?.availableCommands);
        if (commands.length > 0) this.nativeCommands = commands;
      },
      onUpdate: (update) => this.#handleAcpUpdate(state, update),
      onPermission: (request) => this.#handlePermissionRequest(state, request),
      onExit: (error) => this.#handleAcpExit(state, error),
    });
  }

  async #ensureAcp(state) {
    if (state.sourceAccountId && state.sourceAccountId !== this.activeAccountId) {
      throw new Error('该历史线程属于另一个 Grok 账号，请先切换回对应账号');
    }
    if (state.acp && state.acp.closed !== true) return state.acp;
    if (state.acpStartPromise) return state.acpStartPromise;

    const acp = this.#createAcpClient(state);
    state.acp = acp;
    state.acpStartPromise = acp.start().then(() => {
      state.acpSessionId = acp.acpSessionId;
      return acp;
    }).catch((error) => {
      if (state.acp === acp) state.acp = null;
      acp.close();
      throw error;
    }).finally(() => {
      state.acpStartPromise = null;
    });
    return state.acpStartPromise;
  }

  #recordsFromTranscript(state, blocks, completedAt) {
    const transcriptBlocks = Array.isArray(blocks) ? blocks.slice(0, 2_000) : [];
    const createdAt = Math.max(0, completedAt - Math.max(1, transcriptBlocks.length) * 1_000);
    const records = [];
    let previousUserMessageId = null;
    transcriptBlocks.forEach((block, index) => {
      const content = typeof block?.content === 'string' ? block.content.trim() : '';
      if (!content) return;
      const timestamp = createdAt + index * 1_000;
      const role = block?.role === 'user' ? 'user' : 'assistant';
      const messageID = makeId('msg');
      const part = {
        id: makeId('prt'),
        sessionID: state.id,
        messageID,
        type: 'text',
        text: content,
        time: { start: timestamp, end: timestamp },
      };
      if (role === 'user') {
        previousUserMessageId = messageID;
        records.push({
          info: {
            id: messageID,
            sessionID: state.id,
            role: 'user',
            time: { created: timestamp },
            agent: 'build',
            model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
          },
          parts: [part],
        });
        return;
      }
      records.push({
        info: {
          id: messageID,
          sessionID: state.id,
          role: 'assistant',
          time: { created: timestamp, completed: timestamp },
          ...(previousUserMessageId ? { parentID: previousUserMessageId } : {}),
          modelID: MODEL_ID,
          providerID: PROVIDER_ID,
          mode: 'build',
          agent: 'build',
          path: { cwd: state.directory, root: state.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'stop',
        },
        parts: [part],
      });
    });
    return records;
  }

  async #ensureNativeTranscript(state) {
    if (!state.nativeSessionId || state.nativeTranscriptLoaded) return;
    if (!this.nativeSessionLoader) {
      state.nativeTranscriptLoaded = true;
      return;
    }
    const preview = await this.nativeSessionLoader(state.nativeSessionId);
    const firstUserText = Array.isArray(preview?.blocks)
      ? preview.blocks.find((block) => block?.role === 'user' && typeof block.content === 'string')?.content
      : '';
    if (!state.title || state.title === '未命名 Grok 会话' || state.title.endsWith('· Grok 会话')) {
      const promptTitle = String(firstUserText || '').replace(/\s+/g, ' ').trim();
      state.title = promptTitle
        ? localizeGrokSessionTitle(promptTitle.slice(0, 60), state.directory)
        : localizeGrokSessionTitle(preview?.session?.title, state.directory);
    }
    const completedAt = Number.isFinite(preview?.session?.updatedAt)
      ? Number(preview.session.updatedAt)
      : state.time.updated;
    state.time.updated = completedAt;
    this.messages.set(state.id, this.#recordsFromTranscript(state, preview?.blocks, completedAt));
    state.nativeTranscriptLoaded = true;
    await this.#persistSnapshot();
  }

  async syncNativeSessions(nativeSessions = [], accountId = this.activeAccountId) {
    await this.#hydrate();
    const normalizedAccountId = String(accountId || this.activeAccountId);
    let changed = false;
    for (const native of Array.isArray(nativeSessions) ? nativeSessions : []) {
      const nativeSessionId = String(native?.id ?? '').trim();
      if (!NATIVE_SESSION_ID_PATTERN.test(nativeSessionId)) continue;
      const existing = [...this.sessions.values()].find((state) => (
        state.nativeSessionId === nativeSessionId
        && state.sourceAccountId === normalizedAccountId
      ));
      if (existing) {
        const nextDirectory = normalizeDirectory(native.cwd, existing.directory);
        const nextTitle = localizeGrokSessionTitle(native.title || existing.title, nextDirectory);
        const nextUpdated = Number.isFinite(native.updatedAt) ? Number(native.updatedAt) : existing.time.updated;
        if (existing.title !== nextTitle || existing.directory !== nextDirectory || existing.time.updated !== nextUpdated) {
          existing.title = nextTitle;
          existing.directory = nextDirectory;
          existing.time.updated = nextUpdated;
          changed = true;
        }
        continue;
      }
      const completedAt = Number.isFinite(native.updatedAt) ? Number(native.updatedAt) : now();
      const state = {
        id: makeId('ses'),
        directory: normalizeDirectory(native.cwd, this.defaultDirectory),
        title: localizeGrokSessionTitle(native.title, native.cwd),
        agent: 'build',
        time: {
          created: Number.isFinite(native.createdAt) ? Number(native.createdAt) : completedAt,
          updated: completedAt,
        },
        acpSessionId: nativeSessionId,
        nativeSessionId,
        sourceAccountId: normalizedAccountId,
        acp: null,
        acpStartPromise: null,
        activeTurn: null,
        pendingPromise: null,
        cancelRequestedAt: null,
        nativeTranscriptLoaded: false,
      };
      this.sessions.set(state.id, state);
      this.messages.set(state.id, []);
      this.status.set(state.id, { type: 'idle' });
      changed = true;
    }
    if (changed) await this.#persistSnapshot();
    return {
      accountId: normalizedAccountId,
      sessions: [...this.sessions.values()]
        .filter((state) => !state.sourceAccountId || state.sourceAccountId === normalizedAccountId)
        .map((state) => this.#sessionInfo(state)),
    };
  }

  async #createSession(directory, body = {}) {
    const normalized = normalizeDirectory(directory, this.defaultDirectory);
    const id = makeId('ses');
    const timestamp = now();
    const state = {
      id,
      directory: normalized,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '新 Grok 会话',
      agent: typeof body.agent === 'string' && body.agent ? body.agent : 'build',
      time: { created: timestamp, updated: timestamp },
      acpSessionId: null,
      nativeSessionId: null,
      sourceAccountId: null,
      acp: null,
      acpStartPromise: null,
      activeTurn: null,
      pendingPromise: null,
      cancelRequestedAt: null,
      nativeTranscriptLoaded: true,
    };
    this.sessions.set(id, state);
    this.messages.set(id, []);
    this.status.set(id, { type: 'idle' });
    try {
      await this.#ensureAcp(state);
    } catch (error) {
      this.sessions.delete(id);
      this.messages.delete(id);
      this.status.delete(id);
      throw error;
    }
    const info = this.#sessionInfo(state);
    this.#event('session.created', { sessionID: id, info }, normalized);
    await this.#persistSnapshot().catch((error) => {
      this.log(`failed to persist new session ${id}: ${error.message}`);
    });
    return state;
  }

  async importNativeSession({ nativeSessionId, directory, title, blocks = [], updatedAt = null } = {}) {
    const normalizedNativeId = String(nativeSessionId ?? '').trim();
    if (!NATIVE_SESSION_ID_PATTERN.test(normalizedNativeId)) {
      throw new Error('无效的 Grok 原生会话 ID');
    }
    const existing = [...this.sessions.values()].find((state) => (
      state.nativeSessionId === normalizedNativeId
      && state.sourceAccountId === this.activeAccountId
    ));
    if (existing) {
      await this.#ensureAcp(existing);
      return this.#sessionInfo(existing);
    }

    const normalized = normalizeDirectory(directory, this.defaultDirectory);
    const id = makeId('ses');
    const completedAt = Number.isFinite(updatedAt) ? Number(updatedAt) : now();
    const transcriptBlocks = Array.isArray(blocks) ? blocks.slice(0, 2_000) : [];
    const createdAt = Math.max(0, completedAt - Math.max(1, transcriptBlocks.length) * 1_000);
    const state = {
      id,
      directory: normalized,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Grok 历史会话',
      agent: 'build',
      time: { created: createdAt, updated: completedAt },
      acpSessionId: normalizedNativeId,
      nativeSessionId: normalizedNativeId,
      sourceAccountId: this.activeAccountId,
      acp: null,
      acpStartPromise: null,
      activeTurn: null,
      pendingPromise: null,
      cancelRequestedAt: null,
      nativeTranscriptLoaded: true,
    };
    const records = [];
    let previousUserMessageId = null;
    transcriptBlocks.forEach((block, index) => {
      const content = typeof block?.content === 'string' ? block.content.trim() : '';
      if (!content) return;
      const timestamp = createdAt + index * 1_000;
      const role = block?.role === 'user' ? 'user' : 'assistant';
      const messageID = makeId('msg');
      const part = {
        id: makeId('prt'),
        sessionID: id,
        messageID,
        type: 'text',
        text: content,
        time: { start: timestamp, end: timestamp },
      };
      if (role === 'user') {
        previousUserMessageId = messageID;
        records.push({
          info: {
            id: messageID,
            sessionID: id,
            role: 'user',
            time: { created: timestamp },
            agent: 'build',
            model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
          },
          parts: [part],
        });
        return;
      }
      records.push({
        info: {
          id: messageID,
          sessionID: id,
          role: 'assistant',
          time: { created: timestamp, completed: timestamp },
          ...(previousUserMessageId ? { parentID: previousUserMessageId } : {}),
          modelID: MODEL_ID,
          providerID: PROVIDER_ID,
          mode: 'build',
          agent: 'build',
          path: { cwd: normalized, root: normalized },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'stop',
        },
        parts: [part],
      });
    });

    this.sessions.set(id, state);
    this.messages.set(id, records);
    this.status.set(id, { type: 'idle' });
    try {
      await this.#ensureAcp(state);
    } catch (error) {
      this.sessions.delete(id);
      this.messages.delete(id);
      this.status.delete(id);
      throw error;
    }
    const info = this.#sessionInfo(state);
    this.#event('session.created', { sessionID: id, info }, normalized);
    await this.#persistSnapshot();
    return info;
  }

  #messageRecords(sessionId) {
    return this.messages.get(sessionId) ?? [];
  }

  #appendMessage(sessionId, info, parts) {
    const records = this.#messageRecords(sessionId);
    const record = { info, parts };
    records.push(record);
    this.messages.set(sessionId, records);
    const state = this.sessions.get(sessionId);
    if (!state) return record;
    this.#event('message.updated', { sessionID: sessionId, info }, state.directory);
    for (const part of parts) this.#event('message.part.updated', { sessionID: sessionId, part, time: now() }, state.directory);
    return record;
  }

  #upsertPart(state, record, part) {
    const index = record.parts.findIndex((candidate) => candidate.id === part.id);
    if (index >= 0) record.parts[index] = part;
    else record.parts.push(part);
    this.#event('message.part.updated', { sessionID: state.id, part, time: now() }, state.directory);
  }

  #setStatus(state, status) {
    this.status.set(state.id, status);
    this.#event('session.status', { sessionID: state.id, status }, state.directory);
    if (status.type === 'idle') this.#event('session.idle', { sessionID: state.id }, state.directory);
  }

  #handleAcpUpdate(state, update) {
    const kind = update.sessionUpdate;
    if (kind === 'session_info_update') {
      const title = localizeGrokSessionTitle(update.title, state.directory);
      if (title && title !== state.title) {
        state.title = title;
        this.#event('session.updated', { sessionID: state.id, info: this.#sessionInfo(state) }, state.directory);
        void this.#persistSnapshot().catch((error) => {
          this.log(`failed to persist Grok session title ${state.id}: ${error.message}`);
        });
      }
      return;
    }
    const turn = state.activeTurn;
    if (!turn) return;
    if (kind === 'agent_message_chunk') {
      const text = contentText(update.content);
      if (!text) return;
      turn.textPart.text += text;
      this.#upsertPart(state, turn.assistantRecord, { ...turn.textPart });
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = contentText(update.content);
      if (!text) return;
      turn.reasoningPart.text += text;
      this.#upsertPart(state, turn.assistantRecord, { ...turn.reasoningPart });
      return;
    }
    if (kind === 'plan') {
      const text = contentText(update.entries ?? update.plan ?? update.content ?? update);
      if (!text) return;
      turn.reasoningPart.text += `${turn.reasoningPart.text ? '\n\n' : ''}计划\n${text}`;
      this.#upsertPart(state, turn.assistantRecord, { ...turn.reasoningPart });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const callId = String(update.toolCallId ?? update.toolCallID ?? update.callId ?? update.id ?? makeId('call'));
      let part = turn.toolParts.get(callId);
      const timestamp = now();
      const input = update.rawInput ?? update.input ?? update.parameters ?? {};
      const title = String(update.title ?? update.name ?? update.kind ?? 'Grok 工具');
      const rawStatus = String(update.status ?? (kind === 'tool_call' ? 'running' : 'completed')).toLowerCase();
      if (!part) {
        part = {
          id: makeId('prt'),
          sessionID: state.id,
          messageID: turn.assistantRecord.info.id,
          type: 'tool',
          callID: callId,
          tool: String(update.kind ?? update.name ?? 'grok_tool'),
          state: { status: 'running', input, title, time: { start: timestamp } },
          metadata: { engine: 'grok-acp' },
        };
        turn.toolParts.set(callId, part);
      }
      const start = part.state?.time?.start ?? timestamp;
      if (['completed', 'complete', 'success', 'succeeded'].includes(rawStatus)) {
        part = {
          ...part,
          state: {
            status: 'completed',
            input,
            output: contentText(update.content ?? update.output ?? update.result),
            title,
            metadata: {},
            time: { start, end: timestamp },
          },
        };
      } else if (['error', 'failed', 'failure'].includes(rawStatus)) {
        part = {
          ...part,
          state: {
            status: 'error',
            input,
            error: contentText(update.error ?? update.content ?? update.output) || 'Tool failed',
            metadata: {},
            time: { start, end: timestamp },
          },
        };
      } else {
        part = { ...part, state: { status: 'running', input, title, metadata: {}, time: { start } } };
      }
      turn.toolParts.set(callId, part);
      this.#upsertPart(state, turn.assistantRecord, part);
    }
  }

  #handlePermissionRequest(state, request) {
    const turn = state.activeTurn;
    const params = request.params ?? {};
    const toolCall = params.toolCall ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const callId = String(toolCall.toolCallId ?? toolCall.toolCallID ?? toolCall.callId ?? toolCall.id ?? makeId('call'));
    const permissionId = makeId('perm');
    const action = String(toolCall.kind ?? toolCall.title ?? 'tool');
    const detail = toolCall.rawInput ?? toolCall.input ?? {};
    const permission = {
      id: permissionId,
      sessionID: state.id,
      action,
      resources: [contentText(detail) || String(toolCall.title ?? action)],
      save: [],
      metadata: { title: toolCall.title ?? action, grokOptions: options },
      source: turn ? { type: 'tool', messageID: turn.assistantRecord.info.id, callID: callId } : undefined,
    };
    this.permissions.set(permissionId, { state, permission, options, respond: request.respond });
    this.#event('permission.v2.asked', permission, state.directory);
  }

  #resolvePermission(permissionId, reply) {
    const pending = this.permissions.get(permissionId);
    if (!pending) return false;
    const desiredKinds = reply === 'always'
      ? ['allow_always', 'allow_once', 'allow']
      : reply === 'reject'
        ? ['reject_once', 'reject_always', 'reject']
        : ['allow_once', 'allow', 'allow_always'];
    let selected = null;
    for (const desired of desiredKinds) {
      selected = pending.options.find((option) => option?.kind === desired || option?.optionId === desired);
      if (selected) break;
    }
    selected ??= pending.options[reply === 'reject' ? pending.options.length - 1 : 0];
    const optionId = selected?.optionId ?? selected?.id;
    pending.respond({ outcome: { outcome: 'selected', optionId } });
    this.permissions.delete(permissionId);
    this.#event('permission.v2.replied', {
      sessionID: pending.state.id,
      requestID: permissionId,
      reply,
    }, pending.state.directory);
    return true;
  }

  #handleAcpExit(state, error) {
    if (!this.sessions.has(state.id)) return;
    this.log(`session ${state.id} ACP exited: ${error.message}`);
    state.acp = null;
    if (state.activeTurn) {
      const assistant = state.activeTurn.assistantRecord.info;
      assistant.time.completed = now();
      const cancelled = Number.isFinite(state.cancelRequestedAt)
        || /cancel(?:led|ed)|aborted|interrupted/i.test(String(error?.message || ''));
      assistant.finish = cancelled ? 'cancelled' : 'error';
      if (!cancelled) {
        assistant.error = { name: 'UnknownError', data: { message: error.message } };
      }
      this.#event('message.updated', { sessionID: state.id, info: assistant }, state.directory);
      state.activeTurn = null;
    }
    state.cancelRequestedAt = null;
    this.#setStatus(state, { type: 'idle' });
    void this.#persistSnapshot().catch((persistError) => {
      this.log(`failed to persist ACP exit for session ${state.id}: ${persistError.message}`);
    });
  }

  #extractPromptText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => {
      if (part?.type === 'text') return String(part.text ?? '');
      if (part?.type === 'file') {
        const label = part.filename ?? part.url ?? 'attachment';
        return `[附件: ${label}]`;
      }
      if (part?.type === 'agent') return `@${part.name ?? 'agent'}`;
      return '';
    }).filter(Boolean).join('\n');
  }

  async #prompt(state, body) {
    if (state.pendingPromise) throw Object.assign(new Error('Session is busy'), { statusCode: 409 });
    const text = this.#extractPromptText(body.parts);
    if (!text.trim()) throw Object.assign(new Error('Prompt has no text content'), { statusCode: 400 });
    await this.#ensureNativeTranscript(state);
    const acp = await this.#ensureAcp(state);
    state.cancelRequestedAt = null;
    const timestamp = now();
    const userMessageId = body.messageID ?? makeId('msg');
    const userInfo = {
      id: userMessageId,
      sessionID: state.id,
      role: 'user',
      time: { created: timestamp },
      agent: body.agent ?? state.agent,
      model: body.model ?? { providerID: PROVIDER_ID, modelID: MODEL_ID },
    };
    const userParts = [{
      id: makeId('prt'),
      sessionID: state.id,
      messageID: userMessageId,
      type: 'text',
      text,
    }];
    this.#appendMessage(state.id, userInfo, userParts);

    if (state.title === '新 Grok 会话') {
      state.title = text.replace(/\s+/g, ' ').slice(0, 60) || state.title;
      state.time.updated = timestamp;
      this.#event('session.updated', { sessionID: state.id, info: this.#sessionInfo(state) }, state.directory);
    }
    await this.#persistSnapshot().catch((error) => {
      this.log(`failed to persist prompt for session ${state.id}: ${error.message}`);
    });

    const assistantMessageId = makeId('msg');
    const assistantInfo = {
      id: assistantMessageId,
      sessionID: state.id,
      role: 'assistant',
      time: { created: timestamp },
      parentID: userMessageId,
      modelID: MODEL_ID,
      providerID: PROVIDER_ID,
      mode: state.agent,
      agent: state.agent,
      path: { cwd: state.directory, root: state.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const textPart = {
      id: makeId('prt'),
      sessionID: state.id,
      messageID: assistantMessageId,
      type: 'text',
      text: '',
      time: { start: timestamp },
    };
    const reasoningPart = {
      id: makeId('prt'),
      sessionID: state.id,
      messageID: assistantMessageId,
      type: 'reasoning',
      text: '',
      time: { start: timestamp },
    };
    const assistantRecord = this.#appendMessage(state.id, assistantInfo, []);
    state.activeTurn = { assistantRecord, textPart, reasoningPart, toolParts: new Map() };
    this.#setStatus(state, { type: 'busy' });

    const run = (async () => {
      try {
        const result = await acp.request('session/prompt', {
          sessionId: acp.acpSessionId,
          prompt: [{ type: 'text', text }],
        });
        const completed = now();
        if (textPart.text && !assistantRecord.parts.some((part) => part.id === textPart.id)) {
          this.#upsertPart(state, assistantRecord, { ...textPart, time: { start: timestamp, end: completed } });
        }
        if (reasoningPart.text && !assistantRecord.parts.some((part) => part.id === reasoningPart.id)) {
          this.#upsertPart(state, assistantRecord, { ...reasoningPart, time: { start: timestamp, end: completed } });
        }
        assistantInfo.time.completed = completed;
        assistantInfo.finish = result?.stopReason ?? 'stop';
        state.time.updated = completed;
        this.#event('message.updated', { sessionID: state.id, info: assistantInfo }, state.directory);
        this.#event('session.updated', { sessionID: state.id, info: this.#sessionInfo(state) }, state.directory);
        return assistantRecord;
      } catch (error) {
        const completed = now();
        assistantInfo.time.completed = completed;
        const cancelled = Number.isFinite(state.cancelRequestedAt)
          || /cancel(?:led|ed)|aborted|interrupted/i.test(String(error?.message || ''));
        assistantInfo.finish = cancelled ? 'cancelled' : 'error';
        if (!cancelled) {
          assistantInfo.error = { name: 'UnknownError', data: { message: error.message } };
        }
        this.#event('message.updated', { sessionID: state.id, info: assistantInfo }, state.directory);
        if (cancelled) return assistantRecord;
        throw error;
      } finally {
        state.activeTurn = null;
        state.pendingPromise = null;
        state.cancelRequestedAt = null;
        this.#setStatus(state, { type: 'idle' });
        await this.#persistSnapshot().catch((error) => {
          this.log(`failed to persist completed turn for session ${state.id}: ${error.message}`);
        });
      }
    })();
    state.pendingPromise = run;
    return run;
  }

  #openSse(req, res, directory) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, directory };
    this.sseClients.add(client);
    req.on('close', () => this.sseClients.delete(client));
  }

  async #handleRequest(req, res) {
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const url = new URL(req.url ?? '/', origin);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const method = req.method ?? 'GET';
    const directory = normalizeDirectory(url.searchParams.get('directory') ?? this.defaultDirectory, this.defaultDirectory);

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      res.end();
      return;
    }

    if (method === 'POST' && pathname === '/grok/browser/tool') {
      const expected = `Bearer ${this.browserControlToken}`;
      if (req.headers.authorization !== expected) {
        jsonResponse(res, 401, { error: 'Unauthorized browser controller request' });
        return;
      }
      if (!this.browserController || typeof this.browserController.invoke !== 'function') {
        jsonResponse(res, 503, { error: 'No active Grok Code browser controller' });
        return;
      }
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) {
        jsonResponse(res, 400, { error: 'Browser tool name is required' });
        return;
      }
      try {
        const result = await this.browserController.invoke(
          name,
          body?.arguments && typeof body.arguments === 'object' ? body.arguments : {},
        );
        jsonResponse(res, 200, { ok: true, result: result ?? null });
      } catch (error) {
        jsonResponse(res, 500, { error: error?.message || String(error) });
      }
      return;
    }

    if (method === 'GET' && (pathname === '/global/event' || pathname === '/event')) {
      this.#openSse(req, res, pathname === '/event' ? directory : null);
      return;
    }
    if (method === 'GET' && pathname === '/global/health') {
      jsonResponse(res, 200, { healthy: true, version: `grok-acp-${BRIDGE_VERSION}` });
      return;
    }
    if (method === 'GET' && pathname === '/global/config') {
      jsonResponse(res, 200, {});
      return;
    }
    if (method === 'PATCH' && pathname === '/global/config') {
      jsonResponse(res, 200, await readJsonBody(req));
      return;
    }
    if (method === 'GET' && pathname === '/path') {
      jsonResponse(res, 200, {
        home: homedir(),
        state: path.join(homedir(), '.grok'),
        config: path.join(homedir(), '.grok'),
        worktree: directory,
        directory,
      });
      return;
    }
    if (method === 'GET' && pathname === '/project') {
      const directories = new Set([directory, ...[...this.sessions.values()].map((state) => state.directory)]);
      jsonResponse(res, 200, [...directories].map((value) => this.#project(value)));
      return;
    }
    if (method === 'GET' && pathname === '/project/current') {
      jsonResponse(res, 200, this.#project(directory));
      return;
    }
    const projectDirectories = pathname.match(/^\/project\/([^/]+)\/directories$/);
    if (method === 'GET' && projectDirectories) {
      const values = new Set([directory, ...[...this.sessions.values()].filter((state) => projectIdFor(state.directory) === projectDirectories[1]).map((state) => state.directory)]);
      jsonResponse(res, 200, [...values]);
      return;
    }
    if (method === 'GET' && pathname === '/vcs') {
      const branch = this.#gitBranch(directory);
      jsonResponse(res, 200, branch ? { branch } : {});
      return;
    }
    if (method === 'GET' && pathname === '/vcs/diff/raw') {
      const diffs = this.#gitDiff(directory);
      jsonResponse(res, 200, { patch: diffs.map((diff) => diff.patch).join('\n') });
      return;
    }
    if (method === 'GET' && pathname === '/agent') {
      const inspect = await this.#inspect(directory);
      jsonResponse(res, 200, this.#agentList(inspect));
      return;
    }
    if (method === 'GET' && pathname === '/config') {
      jsonResponse(res, 200, {
        model: `${PROVIDER_ID}/${MODEL_ID}`,
        small_model: `${PROVIDER_ID}/${MODEL_ID}`,
        default_agent: 'build',
        agent: {
          build: { model: `${PROVIDER_ID}/${MODEL_ID}`, description: 'Grok 编码与执行代理' },
          plan: { model: `${PROVIDER_ID}/${MODEL_ID}`, description: 'Grok 只读规划代理' },
        },
      });
      return;
    }
    if (method === 'PATCH' && pathname === '/config') {
      jsonResponse(res, 200, await readJsonBody(req));
      return;
    }
    if (method === 'GET' && pathname === '/config/providers') {
      jsonResponse(res, 200, { providers: [createProvider()], default: { [PROVIDER_ID]: MODEL_ID } });
      return;
    }
    if (method === 'GET' && pathname === '/provider') {
      jsonResponse(res, 200, { all: [createProvider()], default: { [PROVIDER_ID]: MODEL_ID }, connected: [PROVIDER_ID] });
      return;
    }
    if (method === 'GET' && pathname === '/provider/auth') {
      jsonResponse(res, 200, { [PROVIDER_ID]: [] });
      return;
    }
    if (method === 'GET' && pathname === '/experimental/capabilities') {
      const inspect = await this.#inspect(directory);
      jsonResponse(res, 200, this.#capabilitySummary(inspect).features);
      return;
    }
    if (method === 'GET' && pathname === '/skill') {
      const inspect = await this.#inspect(directory);
      jsonResponse(res, 200, this.#skillList(inspect));
      return;
    }
    if (method === 'GET' && pathname === '/command') {
      jsonResponse(res, 200, this.nativeCommands);
      return;
    }
    if (method === 'GET' && ['/lsp', '/formatter', '/question'].includes(pathname)) {
      jsonResponse(res, 200, []);
      return;
    }
    if (method === 'GET' && pathname === '/mcp') {
      const inspect = await this.#inspect(directory);
      jsonResponse(res, 200, this.#mcpStatus(inspect));
      return;
    }
    if (method === 'POST' && pathname === '/mcp') {
      jsonResponse(res, 501, {
        error: '请在 Grok Code 的 MCP 设置页或 Grok CLI 中添加服务器；动态会话级添加暂未开放。',
      });
      return;
    }
    const mcpConnect = pathname.match(/^\/mcp\/([^/]+)\/connect$/);
    if (method === 'POST' && mcpConnect) {
      const name = decodeURIComponent(mcpConnect[1]);
      const inspect = await this.#inspect(directory, { force: true });
      if (!this.#mcpStatus(inspect)[name]) {
        jsonResponse(res, 404, { error: `MCP server not found: ${name}` });
        return;
      }
      try {
        const diagnostic = await Promise.resolve(this.mcpDoctorRunner(name, directory));
        this.discoveryCache.delete(normalizeDirectory(directory, this.defaultDirectory));
        jsonResponse(res, 200, { ok: true, diagnostic: diagnostic ?? null });
      } catch (error) {
        jsonResponse(res, 500, { error: error.message || `MCP doctor failed: ${name}` });
      }
      return;
    }
    const mcpDisconnect = pathname.match(/^\/mcp\/([^/]+)\/disconnect$/);
    if (method === 'POST' && mcpDisconnect) {
      // Grok resolves compatibility MCP servers when an ACP session starts.
      // There is no safe process-global disconnect command, so this is an
      // intentional no-op rather than mutating the user's configuration.
      jsonResponse(res, 200, true);
      return;
    }
    if (pathname.match(/^\/mcp\/[^/]+\/auth(?:\/.*)?$/)) {
      jsonResponse(res, 501, { error: '此 Grok MCP 服务器不支持从桌面桥接层启动 OAuth。' });
      return;
    }
    if (method === 'GET' && pathname === '/grok/capabilities') {
      const inspect = await this.#inspect(directory, { force: url.searchParams.get('refresh') === 'true' });
      jsonResponse(res, 200, this.#capabilitySummary(inspect));
      return;
    }
    if (method === 'GET' && pathname === '/grok/plugins') {
      const inspect = await this.#inspect(directory, { force: url.searchParams.get('refresh') === 'true' });
      jsonResponse(res, 200, { plugins: this.#pluginList(inspect) });
      return;
    }
    if (method === 'GET' && pathname === '/grok/marketplace') {
      try {
        const available = await Promise.resolve(this.availablePluginsRunner(directory));
        jsonResponse(res, 200, {
          plugins: this.#marketplacePluginList(available, url.searchParams.get('query') ?? ''),
        });
      } catch (error) {
        jsonResponse(res, 502, { error: error?.message || 'Failed to load Grok Marketplace' });
      }
      return;
    }
    if (method === 'POST' && pathname === '/grok/plugins/install') {
      const body = await readJsonBody(req);
      const spec = typeof body?.spec === 'string' ? body.spec.trim() : '';
      if (!spec || spec.length > 256 || /[\r\n\0]/.test(spec)) {
        jsonResponse(res, 400, { error: 'Invalid Grok plugin specification' });
        return;
      }
      try {
        const output = await Promise.resolve(this.pluginInstallRunner(spec, directory));
        this.discoveryCache.clear();
        jsonResponse(res, 200, { ok: true, spec, output: output ?? null });
      } catch (error) {
        jsonResponse(res, 500, { error: error?.stderr || error?.message || `Failed to install ${spec}` });
      }
      return;
    }
    if (method === 'POST' && pathname === '/grok/plugins/update') {
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 128 || /[\r\n\0]/.test(name)) {
        jsonResponse(res, 400, { error: 'Invalid Grok plugin name' });
        return;
      }
      try {
        const output = await Promise.resolve(this.pluginUpdateRunner(name, directory));
        this.discoveryCache.clear();
        jsonResponse(res, 200, { ok: true, name, output: output ?? null });
      } catch (error) {
        jsonResponse(res, 500, { error: error?.stderr || error?.message || `Failed to update ${name}` });
      }
      return;
    }
    if (method === 'POST' && pathname === '/grok/plugins/uninstall') {
      const body = await readJsonBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 128 || /[\r\n\0]/.test(name)) {
        jsonResponse(res, 400, { error: 'Invalid Grok plugin name' });
        return;
      }
      try {
        const output = await Promise.resolve(this.pluginUninstallRunner(name, directory));
        this.discoveryCache.clear();
        jsonResponse(res, 200, { ok: true, name, output: output ?? null });
      } catch (error) {
        jsonResponse(res, 500, { error: error?.stderr || error?.message || `Failed to uninstall ${name}` });
      }
      return;
    }
    if (method === 'GET' && pathname === '/grok/worktrees') {
      try {
        const worktrees = await Promise.resolve(this.worktreeRunner(directory));
        jsonResponse(res, 200, { worktrees: Array.isArray(worktrees) ? worktrees : [] });
      } catch (error) {
        jsonResponse(res, 500, { error: error.message || 'Failed to list Grok worktrees' });
      }
      return;
    }
    if (method === 'GET' && pathname === '/permission') {
      const pending = [...this.permissions.values()]
        .filter((entry) => !url.searchParams.get('directory') || entry.state.directory === directory)
        .map((entry) => entry.permission);
      jsonResponse(res, 200, pending);
      return;
    }
    const permissionReply = pathname.match(/^\/permission\/([^/]+)\/reply$/);
    if (method === 'POST' && permissionReply) {
      const body = await readJsonBody(req);
      const ok = this.#resolvePermission(permissionReply[1], body.reply);
      jsonResponse(res, ok ? 200 : 404, ok ? true : { error: 'Permission not found' });
      return;
    }
    if (method === 'GET' && pathname === '/session') {
      const requestedDirectory = url.searchParams.get('directory');
      const values = [...this.sessions.values()]
        .filter((state) => !state.sourceAccountId || state.sourceAccountId === this.activeAccountId)
        .filter((state) => !requestedDirectory || state.directory === directory)
        .map((state) => this.#sessionInfo(state))
        .sort((a, b) => b.time.updated - a.time.updated);
      jsonResponse(res, 200, values);
      return;
    }
    if (method === 'POST' && pathname === '/session') {
      const body = await readJsonBody(req);
      const state = await this.#createSession(directory, body);
      jsonResponse(res, 200, this.#sessionInfo(state));
      return;
    }
    if (method === 'GET' && pathname === '/session/status') {
      const statuses = {};
      for (const state of this.sessions.values()) {
        if (state.sourceAccountId && state.sourceAccountId !== this.activeAccountId) continue;
        if (url.searchParams.get('directory') && state.directory !== directory) continue;
        statuses[state.id] = this.status.get(state.id) ?? { type: 'idle' };
      }
      jsonResponse(res, 200, statuses);
      return;
    }
    const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
    if (sessionMatch) {
      const state = this.sessions.get(sessionMatch[1]);
      if (!state || (state.sourceAccountId && state.sourceAccountId !== this.activeAccountId)) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      if (method === 'GET') {
        jsonResponse(res, 200, this.#sessionInfo(state));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (typeof body.title === 'string') state.title = body.title;
        if (body.time && typeof body.time === 'object') state.time = { ...state.time, ...body.time };
        state.time.updated = now();
        const info = this.#sessionInfo(state);
        this.#event('session.updated', { sessionID: state.id, info }, state.directory);
        await this.#persistSnapshot().catch((error) => {
          this.log(`failed to persist session update ${state.id}: ${error.message}`);
        });
        jsonResponse(res, 200, info);
        return;
      }
      if (method === 'DELETE') {
        state.acp?.close();
        this.sessions.delete(state.id);
        this.messages.delete(state.id);
        this.status.delete(state.id);
        for (const [permissionId, entry] of this.permissions) if (entry.state.id === state.id) this.permissions.delete(permissionId);
        const info = this.#sessionInfo(state);
        this.#event('session.deleted', { sessionID: state.id, info }, state.directory);
        await this.#persistSnapshot().catch((error) => {
          this.log(`failed to persist session deletion ${state.id}: ${error.message}`);
        });
        jsonResponse(res, 200, true);
        return;
      }
    }
    const sessionChildren = pathname.match(/^\/session\/([^/]+)\/children$/);
    if (method === 'GET' && sessionChildren) {
      jsonResponse(res, 200, []);
      return;
    }
    const sessionTodo = pathname.match(/^\/session\/([^/]+)\/todo$/);
    if (method === 'GET' && sessionTodo) {
      jsonResponse(res, 200, []);
      return;
    }
    const sessionDiff = pathname.match(/^\/session\/([^/]+)\/diff$/);
    if (method === 'GET' && sessionDiff) {
      const state = this.sessions.get(sessionDiff[1]);
      jsonResponse(res, state ? 200 : 404, state ? this.#gitDiff(state.directory) : { error: 'Session not found' });
      return;
    }
    const sessionMessages = pathname.match(/^\/session\/([^/]+)\/message$/);
    if (sessionMessages) {
      const state = this.sessions.get(sessionMessages[1]);
      if (!state) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      if (method === 'GET') {
        await this.#ensureNativeTranscript(state);
        const limit = Number(url.searchParams.get('limit') ?? 0);
        const records = this.#messageRecords(state.id);
        jsonResponse(res, 200, limit > 0 ? records.slice(-limit) : records);
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const record = await this.#prompt(state, body);
          jsonResponse(res, 200, record);
        } catch (error) {
          jsonResponse(res, error.statusCode ?? 500, { error: error.message });
        }
        return;
      }
    }
    const sessionPromptAsync = pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (method === 'POST' && sessionPromptAsync) {
      const state = this.sessions.get(sessionPromptAsync[1]);
      if (!state) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      const body = await readJsonBody(req);
      this.#prompt(state, body).catch((error) => this.log(`async prompt failed: ${error.stack || error}`));
      emptyResponse(res, 204);
      return;
    }
    const sessionAbort = pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (method === 'POST' && sessionAbort) {
      const state = this.sessions.get(sessionAbort[1]);
      if (!state) {
        jsonResponse(res, 404, { error: 'Session not found' });
        return;
      }
      state.cancelRequestedAt = now();
      const sent = state.acp?.cancel() ?? false;
      jsonResponse(res, 200, { cancelled: sent });
      return;
    }

    jsonResponse(res, 404, { error: `Unsupported Grok bridge endpoint: ${method} ${pathname}` });
  }
}

export const createGrokOpenCodeBridge = (options) => new GrokOpenCodeBridge(options);

const parseArgs = (argv) => {
  const options = { port: 4097, host: '127.0.0.1' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') options.port = Number(argv[++index]);
    else if (value === '--host') options.host = argv[++index];
    else if (value === '--grok') options.grokPath = argv[++index];
    else if (value === '--directory') options.defaultDirectory = argv[++index];
  }
  return options;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = parseArgs(process.argv.slice(2));
  const bridge = createGrokOpenCodeBridge(args);
  const address = await bridge.listen(args);
  console.log(`[grok-bridge] listening on http://${address.host}:${address.port}`);
  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
