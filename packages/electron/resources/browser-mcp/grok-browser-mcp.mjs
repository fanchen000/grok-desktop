#!/usr/bin/env node

import readline from 'node:readline';

const controlUrl = process.env.GROK_CODE_BROWSER_CONTROL_URL;
const controlToken = process.env.GROK_CODE_BROWSER_CONTROL_TOKEN;

if (!controlUrl || !controlToken) {
  process.stderr.write('Grok Code browser MCP is missing its loopback controller configuration.\n');
  process.exit(1);
}

const tools = [
  {
    name: 'browser_status',
    description: 'Get the active Grok Code browser page URL, title, viewport, recording state, and available history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the active Grok Code browser pane to an HTTP or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_read_page',
    description: 'Read a bounded accessibility-oriented snapshot of the active page, including visible text, links, buttons, inputs, and headings.',
    inputSchema: {
      type: 'object',
      properties: { maxCharacters: { type: 'integer', minimum: 1000, maximum: 50000 } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element in the active page by CSS selector or visible text. Prefer selectors returned by browser_read_page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description: 'Set or append text in an input, textarea, or contenteditable element and dispatch input/change events.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        append: { type: 'boolean' },
        submit: { type: 'boolean' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the active page by a relative amount or to the top/bottom.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        target: { type: 'string', enum: ['relative', 'top', 'bottom'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_appshot',
    description: 'Capture the current browser page as a PNG Appshot with URL, title, viewport, and timestamp metadata.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', maxLength: 120 } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_record_start',
    description: 'Start recording Grok Code browser navigation and computer-use actions for later replay.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', maxLength: 120 } },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_record_stop',
    description: 'Stop the active browser recording and persist it to the Grok Code replay library.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_replay',
    description: 'Replay a previously recorded browser action sequence by recording ID. Mutating actions remain subject to Grok tool approval.',
    inputSchema: {
      type: 'object',
      properties: { recordingId: { type: 'string' } },
      required: ['recordingId'],
      additionalProperties: false,
    },
  },
];

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const invokeController = async (name, args) => {
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: args ?? {} }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error || `Browser controller failed with HTTP ${response.status}`);
  }
  return payload.result;
};

const handleRequest = async (message) => {
  if (!message || typeof message !== 'object') return;
  const id = message.id;
  const method = message.method;

  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'grok-code-browser', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (method === 'tools/call') {
      const name = String(message.params?.name ?? '');
      if (!tools.some((tool) => tool.name === name)) {
        throw new Error(`Unknown browser tool: ${name}`);
      }
      const result = await invokeController(name, message.params?.arguments ?? {});
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    if (method === 'tools/call') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error?.message || String(error) }],
          isError: true,
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: error?.message || String(error) } });
  }
};

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write('Ignored malformed MCP JSON message.\n');
    return;
  }
  void handleRequest(message);
});
