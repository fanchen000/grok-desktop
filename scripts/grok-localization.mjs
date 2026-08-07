const HAN_PATTERN = /[\u3400-\u9fff]/;
const MOJIBAKE_PATTERN = /\uFFFD|�|����/;

const SKILL_DESCRIPTIONS = new Map(Object.entries({
  xlsx: '读取、创建、编辑和修复 Excel、CSV、TSV 等电子表格，并处理公式、格式、图表与数据清洗。',
  docx: '读取、创建和编辑 Word 文档，包括排版、目录、页眉页脚、图片、批注与修订。',
  pptx: '读取、创建和编辑 PowerPoint 演示文稿，包括版式、图表、备注和模板。',
  pdf: '读取、创建和转换 PDF，支持文本表格提取、合并拆分、OCR、表单与水印。',
  imagine: '生成或编辑图片，并在需要时保持人物、风格和素材的一致性。',
  help: '查看 Grok Build 的配置、认证、MCP、技能、命令、快捷键与使用帮助。',
  'create-skill': '创建新的 Grok 技能，包括 SKILL.md、脚本和参考资料。',
  'check-work': '调用验证智能体检查代码差异、构建、测试和实现正确性。',
  'code-review': '执行严格的代码质量与可维护性审查，识别复杂结构和技术债。',
  'deep-research': '使用并行智能体进行深度研究、交叉验证证据并生成带引用的报告。',
  'agent-reach': '通过适合的平台路线只读检索 GitHub、X、Reddit、YouTube 等公开信息。',
  'opencli-browser': '通过 OpenCLI 驱动隔离浏览器，检查页面、填写表单、点击与提取信息。',
  'opencli-usage': '查看 OpenCLI 的能力地图、通用参数和适合当前任务的下一项工具。',
  'find-skill': '遇到技术问题时搜索成熟技能、GitHub 项目和技术资料，再选择可兼容方案。',
  'desktop-shell': '开发 Electron 桌面主进程、IPC、原生窗口、菜单、更新、深链与子进程。',
  'theme-system': '维护界面主题、语义颜色、按钮、图标、视觉状态和动画性能。',
  'locale-ui-patterns': '维护界面文案、多语言词典、可访问标签、提示、弹窗和导航文本。',
  'performance-engineering': '定位并优化渲染、事件、轮询、缓存、列表和高频状态路径的性能。',
  'sync-state-invariants': '维护会话同步、重连、事件归并、实时状态、缓存与顺序一致性。',
  'ui-api-decoupling': '维护 UI 与运行时 API、认证、代理、桥接、传输和运行时切换边界。',
  'settings-ui-patterns': '开发设置页面、配置控件、响应式布局和设置搜索体验。',
  'relay-transport': '开发 WebSocket、SSE、流式传输和私有中继能力。',
  'drag-to-reorder': '实现列表和卡片的拖拽排序，包括触控与自适应布局。',
  'cloudflare-deploy': '将应用部署到 Cloudflare Workers、Pages 等平台。',
  'gh-address-comments': '处理 GitHub 拉取请求中的审阅意见并验证修改。',
  'gh-fix-ci': '分析并修复 GitHub Actions 中失败的持续集成检查。',
  'security-best-practices': '按语言和框架检查安全最佳实践并提出加固方案。',
  'build-with-ai': '为应用选择并集成 AI 模型、流式对话和相关 SDK。',
  'create-workflow': '创建 Grok Build 多智能体工作流，支持阶段、并行、校验与持久化运行。',
  'execute-plan': '按设计文档中的任务依赖执行实施计划，并使用隔离工作树并行推进。',
  implement: '执行实现、审查、修复的闭环，直到关键问题全部解决。',
  review: '审查当前代码变更、分支或 GitHub 拉取请求，并输出可执行问题清单。',
  design: '运行设计文档编写与审查闭环，形成可执行的实现计划。',
  'pr-babysit': '持续跟进拉取请求，处理 CI、审阅意见、冲突和堆叠分支。',
  cancel: '停止当前仓库中正在运行的后台多 CLI 任务。',
  status: '查看当前仓库中正在运行和最近完成的后台任务。',
  result: '查看已完成后台任务保存的最终结果。',
  setup: '检测并配置可用的 CLI、MCP 和必要运行环境。',
}));

const COMMAND_DESCRIPTIONS = new Map(Object.entries({
  compact: '压缩当前对话历史，释放上下文空间，并可指定需要保留的重点。',
  'always-approve': '开启或关闭自动批准模式，跳过工具权限确认。',
  context: '查看当前上下文窗口使用量与会话统计。',
  'session-info': '查看当前会话的模型、轮次和上下文使用情况。',
  'deep-research': '启动有边界的并行深度研究，交叉核验证据并生成报告。',
  workflow: '启动、暂停、恢复、停止或保存 Grok 工作流。',
  goal: '设置、查看、暂停、恢复或清除 Grok 自主目标。',
}));

const AGENT_DESCRIPTIONS = new Map(Object.entries({
  'general-purpose': '处理需要多步骤执行的通用任务。',
  explore: '快速、只读地探索代码库结构和实现路径。',
  plan: '分析需求并设计软件实现方案。',
  build: '执行编码、工具调用、文件修改与验证。',
}));

const hasUsableChinese = (value) => HAN_PATTERN.test(value) && !MOJIBAKE_PATTERN.test(value);

const categoryDescription = (name) => {
  const normalized = String(name || '').toLowerCase();
  if (normalized.includes('lark') || normalized.includes('feishu')) return `处理 ${name} 对应的飞书能力。`;
  if (normalized.includes('deploy')) return `处理 ${name} 相关的部署与发布任务。`;
  if (normalized.includes('review') || normalized.includes('audit')) return `使用 ${name} 执行审查、核验和问题定位。`;
  if (normalized.includes('resume')) return `恢复并继续 ${name.replace(/^resume-/, '')} 的历史任务或会话。`;
  if (normalized.includes('research') || normalized.includes('search')) return `使用 ${name} 搜索、研究并整理相关信息。`;
  if (normalized.includes('browser')) return `使用 ${name} 完成浏览器检查与交互。`;
  if (normalized.includes('workflow')) return `使用 ${name} 编排并执行多步骤工作流。`;
  if (normalized.includes('agent')) return `使用 ${name} 处理智能体相关任务。`;
  return `使用 ${name} 处理对应的专业任务。`;
};

export const localizeGrokSkillDescription = (name, description) => {
  const mapped = SKILL_DESCRIPTIONS.get(String(name || '').toLowerCase());
  if (mapped) return mapped;
  const raw = String(description || '').trim();
  if (hasUsableChinese(raw)) return raw;
  return categoryDescription(name);
};

export const localizeGrokCommandDescription = (name, description) => {
  const mapped = COMMAND_DESCRIPTIONS.get(String(name || '').toLowerCase());
  if (mapped) return mapped;
  const raw = String(description || '').trim();
  if (hasUsableChinese(raw)) return raw;
  return `执行 Grok 原生命令 /${name}。`;
};

export const localizeGrokAgentDescription = (name, description) => {
  const mapped = AGENT_DESCRIPTIONS.get(String(name || '').toLowerCase());
  if (mapped) return mapped;
  const raw = String(description || '').trim();
  if (hasUsableChinese(raw)) return raw;
  return `Grok 子智能体：${name}。`;
};

export const localizeGrokSessionTitle = (title, directory = '') => {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw || /^\(no summary\)$/i.test(raw) || MOJIBAKE_PATTERN.test(raw)) return '未命名 Grok 会话';
  if (hasUsableChinese(raw)) return raw.slice(0, 80);
  const lower = raw.toLowerCase();
  if (lower.includes('browser status')) return '浏览器状态工具检查';
  if (lower.includes('mandatory browser')) return '浏览器工具调用验证';
  if (lower.includes('session') && lower.includes('resume')) return '恢复 Grok 历史会话';
  if (lower.includes('account') && lower.includes('switch')) return 'Grok 账号切换';
  const project = String(directory || '').split(/[\\/]/).filter(Boolean).at(-1);
  return project ? `${project} · Grok 会话` : 'Grok 会话';
};

export const normalizeGrokCommands = (value) => (Array.isArray(value) ? value : []).flatMap((command) => {
  const name = typeof command?.name === 'string' ? command.name.trim() : '';
  if (!name) return [];
  return [{
    name,
    description: localizeGrokCommandDescription(name, command.description),
    source: 'grok-native',
    template: `/${name}${command?.input?.hint ? ` ${command.input.hint}` : ''}`,
    scope: 'user',
  }];
});
