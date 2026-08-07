import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSessionCancelNotification, createGrokOpenCodeBridge } from './grok-opencode-bridge.mjs';

const start = async (options = {}) => {
  const bridge = createGrokOpenCodeBridge({
    stateFile: null,
    log: () => undefined,
    inspectRunner: () => ({
      grokVersion: 'test',
      projectTrusted: true,
      skills: [],
      agents: [],
      plugins: [],
      mcpServers: [],
    }),
    worktreeRunner: () => [],
    mcpDoctorRunner: () => ({ ok: true }),
    ...options,
  });
  const address = await bridge.listen({ port: 0, host: '127.0.0.1' });
  return {
    bridge,
    origin: `http://${address.host}:${address.port}`,
  };
};

const withTemporaryState = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grok-code-bridge-'));
  const stateFile = path.join(directory, 'sessions.json');
  try {
    return await run({ directory, stateFile });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const createFakeAcpFactory = (starts) => (options) => ({
  acpSessionId: null,
  closed: false,
  async start() {
    starts.push(options.resumeSessionId ?? null);
    this.acpSessionId = options.resumeSessionId ?? `native-session-${starts.length}`;
  },
  async request(method) {
    assert.equal(method, 'session/prompt');
    options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'FAKE_GROK_OK' } });
    return { stopReason: 'stop' };
  },
  async cancel() {},
  close() {
    this.closed = true;
  },
});

test('health and Grok provider surface are OpenCode-compatible', async (t) => {
  const fixture = await start();
  t.after(() => fixture.bridge.close());

  const health = await fetch(`${fixture.origin}/global/health`).then((response) => response.json());
  assert.equal(health.healthy, true);

  const providers = await fetch(`${fixture.origin}/config/providers`).then((response) => response.json());
  assert.equal(providers.providers[0].id, 'xai');
  assert.equal(providers.default.xai, 'grok-build');

  const agents = await fetch(`${fixture.origin}/agent`).then((response) => response.json());
  assert.deepEqual(agents.map((agent) => agent.name), ['build', 'plan']);

  const commands = await fetch(`${fixture.origin}/command`).then((response) => response.json());
  assert.ok(commands.some((command) => command.name === 'context'));
  assert.match(commands.find((command) => command.name === 'context').description, /上下文/);
});

test('ACP cancel is an id-less notification with Grok cancellation metadata', () => {
  const message = buildSessionCancelNotification('native-session', 42);
  assert.equal(message.method, 'session/cancel');
  assert.equal(Object.hasOwn(message, 'id'), false);
  assert.deepEqual(message.params, {
    sessionId: 'native-session',
    reason: 'user',
    _meta: {
      cancelSubagents: true,
      cancelTrigger: 'mouse',
      cancelPromptId: '42',
    },
  });
});

test('abort responds immediately and settles the active Grok turn as cancelled', async (t) => {
  let rejectPrompt = null;
  let cancelCalls = 0;
  const fixture = await start({
    acpClientFactory: () => ({
      acpSessionId: null,
      closed: false,
      async start() { this.acpSessionId = 'native-cancel-session'; },
      request(method) {
        assert.equal(method, 'session/prompt');
        return new Promise((_resolve, reject) => { rejectPrompt = reject; });
      },
      cancel() {
        cancelCalls += 1;
        rejectPrompt?.(new Error('cancelled by user'));
        return true;
      },
      close() { this.closed = true; },
    }),
  });
  t.after(() => fixture.bridge.close());

  const session = await fetch(`${fixture.origin}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'cancel test' }),
  }).then((response) => response.json());
  const started = await fetch(`${fixture.origin}/session/${session.id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'keep working' }] }),
  });
  assert.equal(started.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const before = performance.now();
  const aborted = await fetch(`${fixture.origin}/session/${session.id}/abort`, { method: 'POST' });
  const elapsed = performance.now() - before;
  assert.equal(aborted.status, 200);
  assert.deepEqual(await aborted.json(), { cancelled: true });
  assert.ok(elapsed < 250, `abort took ${elapsed.toFixed(1)}ms`);
  assert.equal(cancelCalls, 1);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const statuses = await fetch(`${fixture.origin}/session/status`).then((response) => response.json());
  assert.deepEqual(statuses[session.id], { type: 'idle' });
  const messages = await fetch(`${fixture.origin}/session/${session.id}/message`).then((response) => response.json());
  assert.equal(messages.at(-1).info.finish, 'cancelled');
  assert.equal(messages.at(-1).info.error, undefined);
});

test('Grok discovery populates agents, skills, MCP, plugins, worktrees, and capabilities', async (t) => {
  const doctorCalls = [];
  const fixture = await start({
    inspectRunner: () => ({
      grokVersion: '0.2.test',
      projectTrusted: true,
      agents: [
        { name: 'plan', description: 'duplicate plan', source: { type: 'builtin' } },
        { name: 'explore', description: 'Read-only explorer', source: { type: 'builtin' } },
      ],
      skills: [
        { name: 'repo-reader', description: 'Read repositories', source: { type: 'project', path: 'C:\\repo\\SKILL.md' } },
        { name: 'built-in-skill', description: 'Built in', source: { type: 'builtin' } },
      ],
      plugins: [{
        name: 'github',
        scope: 'user',
        path: 'C:\\plugins\\github',
        enabled: true,
        provides: { skills: 1, agents: 0, hooks: false, mcpServers: 1 },
      }],
      mcpServers: [
        { name: 'devspace-local', compatibilityStatus: 'enabled' },
        { name: 'disabled-server', compatibilityStatus: 'disabled' },
        { name: 'broken-server', compatibilityStatus: 'failed' },
      ],
    }),
    worktreeRunner: () => [{ id: 'wt-1', path: 'C:\\repo\\.worktrees\\wt-1' }],
    mcpDoctorRunner: (name) => {
      doctorCalls.push(name);
      return { name, status: 'ok' };
    },
  });
  t.after(() => fixture.bridge.close());

  const agents = await fetch(`${fixture.origin}/agent`).then((response) => response.json());
  assert.deepEqual(agents.map((agent) => agent.name), ['build', 'plan', 'explore']);
  assert.equal(agents.find((agent) => agent.name === 'explore').mode, 'subagent');

  const skills = await fetch(`${fixture.origin}/skill`).then((response) => response.json());
  assert.deepEqual(skills.map((skill) => skill.name), ['repo-reader', 'built-in-skill']);
  assert.equal(skills[0].location, 'C:\\repo\\SKILL.md');
  assert.equal(skills[1].location, '<built-in>');

  const mcp = await fetch(`${fixture.origin}/mcp`).then((response) => response.json());
  assert.deepEqual(mcp, {
    'devspace-local': { status: 'connected' },
    'disabled-server': { status: 'disabled' },
    'broken-server': { status: 'failed', error: 'Grok compatibility status: failed' },
  });

  const connect = await fetch(`${fixture.origin}/mcp/devspace-local/connect`, { method: 'POST' });
  assert.equal(connect.status, 200);
  assert.deepEqual(doctorCalls, ['devspace-local']);

  const plugins = await fetch(`${fixture.origin}/grok/plugins`).then((response) => response.json());
  assert.equal(plugins.plugins[0].name, 'github');
  assert.equal(plugins.plugins[0].readOnly, true);

  const worktrees = await fetch(`${fixture.origin}/grok/worktrees`).then((response) => response.json());
  assert.equal(worktrees.worktrees[0].id, 'wt-1');

  const capabilities = await fetch(`${fixture.origin}/grok/capabilities`).then((response) => response.json());
  assert.equal(capabilities.version, '0.2.test');
  assert.deepEqual(capabilities.counts, { agents: 3, skills: 2, plugins: 1, mcpServers: 3 });
  assert.equal(capabilities.features.browser, true);
  assert.equal(capabilities.features.recordReplay, false);
});

test('Grok discovery refresh failure preserves the previous authoritative snapshot', async (t) => {
  let callCount = 0;
  const fixture = await start({
    inspectRunner: () => {
      callCount += 1;
      if (callCount > 1) throw new Error('temporary discovery failure');
      return {
        grokVersion: 'stable',
        projectTrusted: true,
        agents: [],
        skills: [{ name: 'stable-skill', source: { type: 'builtin' } }],
        plugins: [],
        mcpServers: [],
      };
    },
  });
  t.after(() => fixture.bridge.close());

  const initial = await fetch(`${fixture.origin}/skill`).then((response) => response.json());
  assert.equal(initial[0].name, 'stable-skill');

  const refreshed = await fetch(`${fixture.origin}/grok/capabilities?refresh=true`);
  assert.equal(refreshed.status, 200);
  const after = await fetch(`${fixture.origin}/skill`).then((response) => response.json());
  assert.equal(after[0].name, 'stable-skill');
});

test('switching Grok accounts closes the old ACP runtime and forwards the new isolated environment', async (t) => {
  const clients = [];
  const starts = [];
  const factory = (options) => {
    const client = {
      acpSessionId: null,
      closed: false,
      async start() {
        starts.push({ env: { ...options.env }, resumeSessionId: options.resumeSessionId ?? null });
        this.acpSessionId = `native-${starts.length}`;
      },
      async request(method) {
        assert.equal(method, 'session/prompt');
        options.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'ACCOUNT_SWITCH_OK' } });
        return { stopReason: 'stop' };
      },
      async cancel() {},
      close() { this.closed = true; },
    };
    clients.push(client);
    return client;
  };
  const fixture = await start({
    grokEnv: { HOME: 'A', USERPROFILE: 'A' },
    activeAccountId: 'account-a',
    acpClientFactory: factory,
  });
  t.after(() => fixture.bridge.close());

  const session = await fetch(`${fixture.origin}/session?directory=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'account switch test' }),
  }).then((response) => response.json());
  assert.equal(starts[0].env.HOME, 'A');

  await fixture.bridge.switchGrokAccount({
    accountId: 'account-b',
    env: { HOME: 'B', USERPROFILE: 'B', GROK_HOME: 'B/.grok' },
  });
  assert.equal(clients[0].closed, true);

  const prompt = await fetch(`${fixture.origin}/session/${session.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'continue with account B' }] }),
  });
  assert.equal(prompt.status, 200);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].env.HOME, 'B');
  assert.equal(starts[1].env.GROK_HOME, 'B/.grok');
  assert.equal(starts[1].resumeSessionId, null);
});

test('imports a native Grok session with transcript and resumes the original ACP id', async (t) => {
  const starts = [];
  const fixture = await start({
    acpClientFactory: createFakeAcpFactory(starts),
    activeAccountId: 'default',
  });
  t.after(() => fixture.bridge.close());

  const nativeSessionId = '019fd681-3cdd-7363-9269-fb78d8adbea0';
  const imported = await fixture.bridge.importNativeSession({
    nativeSessionId,
    directory: process.cwd(),
    title: '本地 Grok 历史',
    updatedAt: Date.now(),
    blocks: [
      { role: 'user', content: '历史问题' },
      { role: 'assistant', content: '历史回答' },
    ],
  });

  assert.match(imported.id, /^ses_/);
  assert.equal(imported.metadata.nativeSessionId, nativeSessionId);
  assert.deepEqual(starts, [nativeSessionId]);
  const messages = await fetch(`${fixture.origin}/session/${imported.id}/message`).then((response) => response.json());
  assert.deepEqual(messages.map((record) => record.parts[0].text), ['历史问题', '历史回答']);
});

test('syncs native Grok history into the regular session list and lazy-loads each transcript once', async (t) => {
  const nativeId = '019fd9a3-b1ef-7af0-85a7-8047b8891746';
  let loads = 0;
  const fixture = await start({
    activeAccountId: 'default',
    nativeSessionLoader: async (sessionId) => {
      assert.equal(sessionId, nativeId);
      loads += 1;
      return {
        session: {
          id: nativeId,
          title: 'English Native Summary',
          cwd: process.cwd(),
          updatedAt: 2000,
        },
        blocks: [
          { role: 'user', content: '请继续处理这个原生线程' },
          { role: 'assistant', content: '已恢复。' },
        ],
      };
    },
  });
  t.after(() => fixture.bridge.close());

  const firstSync = await fixture.bridge.syncNativeSessions([{
    id: nativeId,
    title: 'English Native Summary',
    cwd: process.cwd(),
    createdAt: 1000,
    updatedAt: 2000,
  }], 'default');
  const secondSync = await fixture.bridge.syncNativeSessions([{
    id: nativeId,
    title: 'English Native Summary',
    cwd: process.cwd(),
    createdAt: 1000,
    updatedAt: 2000,
  }], 'default');

  assert.equal(firstSync.sessions.length, 1);
  const matching = secondSync.sessions.filter((session) => session.metadata?.nativeSessionId === nativeId);
  assert.equal(matching.length, 1);
  assert.match(matching[0].title, /Grok 会话/);

  const firstMessages = await fetch(`${fixture.origin}/session/${matching[0].id}/message`).then((response) => response.json());
  const secondMessages = await fetch(`${fixture.origin}/session/${matching[0].id}/message`).then((response) => response.json());
  assert.equal(loads, 1);
  assert.equal(firstMessages.length, 2);
  assert.equal(secondMessages.length, 2);

  const updated = await fetch(`${fixture.origin}/session/${matching[0].id}`).then((response) => response.json());
  assert.equal(updated.title, '请继续处理这个原生线程');
});

test('Grok Marketplace supports search and explicit trusted installation', async (t) => {
  const installs = [];
  const updates = [];
  const uninstalls = [];
  const fixture = await start({
    availablePluginsRunner: () => [
      {
        status: 'available',
        name: 'chrome-devtools',
        marketplace: 'xAI Official',
        description: 'Browser debugging tools',
        components: {
          skills: [{ name: 'debug' }],
          commands: [],
          agents: [],
          mcpServers: [{ name: 'chrome' }],
          hooks: [],
        },
      },
      {
        status: 'available',
        name: 'sentry',
        marketplace: 'xAI Official',
        description: 'Error monitoring',
        components: {},
      },
    ],
    pluginInstallRunner: async (spec, directory) => {
      installs.push({ spec, directory });
      return { stdout: 'installed', stderr: '' };
    },
    pluginUpdateRunner: async (name, directory) => {
      updates.push({ name, directory });
      return { stdout: 'updated', stderr: '' };
    },
    pluginUninstallRunner: async (name, directory) => {
      uninstalls.push({ name, directory });
      return { stdout: 'uninstalled', stderr: '' };
    },
  });
  t.after(() => fixture.bridge.close());

  const listed = await fetch(`${fixture.origin}/grok/marketplace?query=browser`).then((response) => response.json());
  assert.equal(listed.plugins.length, 1);
  assert.deepEqual(listed.plugins[0], {
    name: 'chrome-devtools',
    marketplace: 'xAI Official',
    spec: 'chrome-devtools@xAI Official',
    version: null,
    description: 'Browser debugging tools',
    counts: { skills: 1, commands: 0, agents: 0, mcpServers: 1, hooks: 0 },
  });

  const installed = await fetch(`${fixture.origin}/grok/plugins/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec: 'chrome-devtools@xAI Official' }),
  });
  assert.equal(installed.status, 200);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].spec, 'chrome-devtools@xAI Official');

  const updated = await fetch(`${fixture.origin}/grok/plugins/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'chrome-devtools' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updates[0].name, 'chrome-devtools');

  const uninstalled = await fetch(`${fixture.origin}/grok/plugins/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'chrome-devtools' }),
  });
  assert.equal(uninstalled.status, 200);
  assert.equal(uninstalls[0].name, 'chrome-devtools');

  const rejected = await fetch(`${fixture.origin}/grok/plugins/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec: 'bad\nplugin' }),
  });
  assert.equal(rejected.status, 400);
});

test('ACP sessions receive the protected Grok Code browser MCP server', async (t) => {
  const captured = [];
  const browserCalls = [];
  const fixture = await start({
    browserController: {
      invoke: async (name, args) => {
        browserCalls.push({ name, args });
        return { active: true, name };
      },
    },
    browserMcpScript: 'C:\\app\\grok-browser-mcp.mjs',
    browserMcpExecutable: 'C:\\app\\Grok Code.exe',
    acpClientFactory: (options) => {
      captured.push(options);
      return {
        acpSessionId: null,
        closed: false,
        async start() { this.acpSessionId = 'native-browser-session'; },
        async request() { return { stopReason: 'stop' }; },
        async cancel() {},
        close() { this.closed = true; },
      };
    },
  });
  t.after(() => fixture.bridge.close());

  const created = await fetch(`${fixture.origin}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'browser MCP' }),
  });
  assert.equal(created.status, 200);
  assert.equal(captured.length, 1);
  const server = captured[0].mcpServers[0];
  assert.equal(server.name, 'grok-code-browser');
  assert.equal(server.command, 'C:\\app\\Grok Code.exe');
  assert.deepEqual(server.args, ['C:\\app\\grok-browser-mcp.mjs']);
  const env = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');

  const unauthorized = await fetch(env.GROK_CODE_BROWSER_CONTROL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'browser_status', arguments: {} }),
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(env.GROK_CODE_BROWSER_CONTROL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROK_CODE_BROWSER_CONTROL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'browser_status', arguments: {} }),
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(browserCalls, [{ name: 'browser_status', args: {} }]);
});

test('real Grok ACP session can answer through OpenCode session endpoints', { timeout: 60_000 }, async (t) => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'grok-code-real-'));
  const fixture = await start({ stateFile: path.join(stateDirectory, 'sessions.json') });
  t.after(async () => {
    await fixture.bridge.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const createdResponse = await fetch(`${fixture.origin}/session?directory=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'ACP integration test' }),
  });
  assert.equal(createdResponse.status, 200);
  const session = await createdResponse.json();
  assert.match(session.id, /^ses_/);

  const promptResponse = await fetch(`${fixture.origin}/session/${session.id}/message?directory=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: '只回复 GROK_OPENCHAMBER_OK，不调用任何工具。' }],
      model: { providerID: 'xai', modelID: 'grok-build' },
      agent: 'build',
    }),
  });
  assert.equal(promptResponse.status, 200);
  const assistant = await promptResponse.json();
  assert.equal(assistant.info.role, 'assistant');
  assert.match(assistant.parts.map((part) => part.text ?? '').join(''), /GROK_OPENCHAMBER_OK/);

  const messages = await fetch(`${fixture.origin}/session/${session.id}/message`).then((response) => response.json());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].info.role, 'user');
  assert.equal(messages[1].info.role, 'assistant');
});

test('real Grok ACP can call the injected browser MCP tool', { timeout: 90_000 }, async (t) => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'grok-code-browser-real-'));
  const browserCalls = [];
  const logs = [];
  const fixture = await start({
    stateFile: path.join(stateDirectory, 'sessions.json'),
    log: (message) => logs.push(String(message)),
    browserController: {
      invoke: async (name, args) => {
        browserCalls.push({ name, args });
        return { active: true, url: 'https://example.test/', title: 'Browser MCP Test' };
      },
    },
    browserMcpScript: path.join(process.cwd(), 'packages', 'electron', 'resources', 'browser-mcp', 'grok-browser-mcp.mjs'),
    browserMcpExecutable: process.execPath,
  });
  t.after(async () => {
    await fixture.bridge.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const session = await fetch(`${fixture.origin}/session?directory=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Browser MCP integration test' }),
  }).then((response) => response.json());

  const promptPromise = fetch(`${fixture.origin}/session/${session.id}/message?directory=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parts: [{ type: 'text', text: '必须调用 browser_status 工具。工具成功后只回复 BROWSER_MCP_OK。' }],
      model: { providerID: 'xai', modelID: 'grok-build' },
      agent: 'build',
    }),
  });

  const approvalDeadline = Date.now() + 30_000;
  while (Date.now() < approvalDeadline && browserCalls.length === 0) {
    const permissions = await fetch(`${fixture.origin}/permission`).then((response) => response.json());
    for (const permission of permissions) {
      await fetch(`${fixture.origin}/permission/${permission.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'once' }),
      });
    }
    if (browserCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const promptResponse = await promptPromise;
  const assistant = await promptResponse.json();
  const externalRateLimit = promptResponse.status === 500
    && /(?:free-usage-exhausted|Rate limited|429 Too Many Requests)/i.test(JSON.stringify(assistant));
  if (externalRateLimit) {
    t.skip('Grok external model quota is exhausted; local MCP protocol tests already cover the integration boundary.');
    return;
  }
  assert.equal(
    promptResponse.status,
    200,
    `Browser MCP prompt failed: ${JSON.stringify(assistant)}\n${logs.join('\n')}`,
  );
  assert.equal(browserCalls.some((call) => call.name === 'browser_status'), true);
  assert.match(assistant.parts.map((part) => part.text ?? '').join(''), /BROWSER_MCP_OK/);
});

test('sessions and messages survive restart and resume the native Grok ACP session', async () => {
  await withTemporaryState(async ({ stateFile }) => {
    const starts = [];
    const factory = createFakeAcpFactory(starts);
    const first = await start({ stateFile, acpClientFactory: factory });

    const created = await fetch(`${first.origin}/session?directory=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '持久会话' }),
    }).then((response) => response.json());

    const firstPrompt = await fetch(`${first.origin}/session/${created.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: '第一次消息' }] }),
    });
    assert.equal(firstPrompt.status, 200);
    await first.bridge.close();
    assert.deepEqual(starts, [null]);

    const second = await start({ stateFile, acpClientFactory: factory });
    try {
      const sessions = await fetch(`${second.origin}/session`).then((response) => response.json());
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, created.id);
      assert.equal(sessions[0].title, '持久会话');

      const restoredMessages = await fetch(`${second.origin}/session/${created.id}/message`).then((response) => response.json());
      assert.equal(restoredMessages.length, 2);
      assert.equal(restoredMessages[0].parts[0].text, '第一次消息');
      assert.match(restoredMessages[1].parts.map((part) => part.text ?? '').join(''), /FAKE_GROK_OK/);

      const resumedPrompt = await fetch(`${second.origin}/session/${created.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: '第二次消息' }] }),
      });
      assert.equal(resumedPrompt.status, 200);
      assert.deepEqual(starts, [null, 'native-session-1']);
    } finally {
      await second.bridge.close();
    }
  });
});

test('malformed persisted state does not masquerade as an empty authoritative snapshot', async () => {
  await withTemporaryState(async ({ stateFile }) => {
    await writeFile(stateFile, '{broken-json', 'utf8');
    const logs = [];
    const bridge = createGrokOpenCodeBridge({
      stateFile,
      log: (message) => logs.push(message),
      acpClientFactory: createFakeAcpFactory([]),
    });
    const address = await bridge.listen({ port: 0, host: '127.0.0.1' });
    try {
      const health = await fetch(`http://${address.host}:${address.port}/global/health`).then((response) => response.json());
      assert.equal(health.healthy, true);
      assert.equal(logs.some((message) => message.includes('malformed persisted session snapshot')), true);
    } finally {
      await bridge.close();
    }
  });
});
