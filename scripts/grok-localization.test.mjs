import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localizeGrokAgentDescription,
  localizeGrokCommandDescription,
  localizeGrokSessionTitle,
  localizeGrokSkillDescription,
  normalizeGrokCommands,
} from './grok-localization.mjs';

test('localizes common Grok skills and never leaks an unknown English description into zh-CN UI', () => {
  assert.match(localizeGrokSkillDescription('xlsx', 'Use this skill any time a spreadsheet is involved'), /电子表格/);
  assert.equal(localizeGrokSkillDescription('lark-im', '飞书即时通讯'), '飞书即时通讯');
  assert.equal(
    localizeGrokSkillDescription('custom-english-skill', 'Use this for a custom task'),
    '使用 custom-english-skill 处理对应的专业任务。',
  );
});

test('localizes native Grok commands and agents', () => {
  assert.match(localizeGrokCommandDescription('deep-research', 'Research deeply'), /深度研究/);
  assert.match(localizeGrokAgentDescription('explore', 'Read only'), /只读/);
  const commands = normalizeGrokCommands([{ name: 'context', description: 'Show context' }]);
  assert.deepEqual(commands, [{
    name: 'context',
    description: '查看当前上下文窗口使用量与会话统计。',
    source: 'grok-native',
    template: '/context',
    scope: 'user',
  }]);
});

test('keeps Chinese session titles and replaces English summaries with a Chinese project title', () => {
  assert.equal(localizeGrokSessionTitle('修复停止按钮', 'D:\\repo'), '修复停止按钮');
  assert.equal(localizeGrokSessionTitle('Call Browser Status Tool Reply OK', 'D:\\repo'), '浏览器状态工具检查');
  assert.equal(localizeGrokSessionTitle('Unmapped English Summary', 'D:\\repo'), 'repo · Grok 会话');
});
