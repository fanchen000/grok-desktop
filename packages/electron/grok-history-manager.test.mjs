import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrokSessionList, parseGrokTranscript } from './grok-history-manager.mjs';

test('parses Grok sessions list without depending on terminal column positions', () => {
  const parsed = parseGrokSessionList(`workspace-a
SESSION ID                           CREATED      UPDATED      STATUS      SUMMARY
019fd681-3cdd-7363-9269-fb78d8adbea0 2026-08-06   2026-08-07   completed   修复登录并验证
019fd69b-a5a3-7980-b5e3-d6212f2465ad 2026-08-06   2026-08-06   active

Total: 2
`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].groupLabel, 'workspace-a');
  assert.equal(parsed[0].title, '修复登录并验证');
  assert.equal(parsed[1].title, '');
});

test('parses exported Markdown into ordered role blocks', () => {
  const blocks = parseGrokTranscript(`## User

请检查项目。

## Assistant

已完成检查。

\`\`\`ts
const ok = true;
\`\`\`
`);
  assert.deepEqual(blocks, [
    { role: 'user', content: '请检查项目。' },
    { role: 'assistant', content: '已完成检查。\n\n```ts\nconst ok = true;\n```' },
  ]);
});
