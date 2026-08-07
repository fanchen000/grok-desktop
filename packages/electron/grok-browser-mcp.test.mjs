import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'resources', 'browser-mcp', 'grok-browser-mcp.mjs');

test('browser MCP exposes tools and forwards calls only with the loopback token', async (t) => {
  const calls = [];
  const token = 'test-token';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { active: true, echo: body.name } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GROK_CODE_BROWSER_CONTROL_URL: `http://127.0.0.1:${address.port}/tool`,
      GROK_CODE_BROWSER_CONTROL_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    child.stdin.end();
    child.kill();
  });

  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message);
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5_000).unref();
    });
  };

  const initialized = await request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'grok-code-browser');

  const listed = await request('tools/list');
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_appshot'), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === 'browser_replay'), true);

  const called = await request('tools/call', { name: 'browser_status', arguments: {} });
  assert.equal(called.result.isError, false);
  assert.match(called.result.content[0].text, /"active": true/);
  assert.deepEqual(calls, [{ name: 'browser_status', arguments: {} }]);
});
