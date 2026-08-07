import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { localizeGrokSessionTitle } from '../../scripts/grok-localization.mjs';

const execFileAsync = promisify(execFile);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ROW_PATTERN = /^([0-9a-f-]{36})\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s*(.*)$/i;
const MAX_LIST_LIMIT = 500;
const MAX_TRANSCRIPT_CHARS = 2_000_000;
const LIST_CACHE_MS = 5_000;

const normalizeComparablePath = (value) => {
  const resolved = path.resolve(String(value ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const normalizeLimit = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, parsed));
};

const safeDate = (value) => {
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeSummary = (value) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^\(no summary\)$/i, '');

export const parseGrokSessionList = (text) => {
  const sessions = [];
  let groupLabel = '';
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || /^SESSION ID\s+/i.test(trimmed) || /^Total:\s*\d+/i.test(trimmed)) continue;
    const match = trimmed.match(SESSION_ROW_PATTERN);
    if (match && SESSION_ID_PATTERN.test(match[1])) {
      sessions.push({
        id: match[1],
        createdAt: safeDate(match[2]),
        updatedAt: safeDate(match[3]),
        status: match[4],
        title: normalizeSummary(match[5]),
        groupLabel,
      });
      continue;
    }
    if (!/^[-=]+$/.test(trimmed)) groupLabel = trimmed === '(no label)' ? '' : trimmed;
  }
  return sessions;
};

export const parseGrokTranscript = (markdown) => {
  const source = String(markdown ?? '').replace(/^\uFEFF/, '');
  const headingPattern = /^##\s+(User|Assistant|System)\s*$/gim;
  const headings = [...source.matchAll(headingPattern)];
  if (headings.length === 0) {
    const content = source.trim();
    return content ? [{ role: 'assistant', content }] : [];
  }
  return headings.flatMap((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? source.length;
    const content = source.slice(start, end).trim();
    if (!content) return [];
    const role = heading[1].toLowerCase();
    return [{ role, content }];
  });
};

const decodeDirectoryLabel = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

class GrokHistoryManager {
  constructor({ grokPath, accountManager, ignoredDirectories = [], execFileImpl = execFileAsync }) {
    if (!grokPath || !accountManager) throw new Error('grokPath and accountManager are required');
    this.grokPath = grokPath;
    this.accountManager = accountManager;
    this.execFileImpl = execFileImpl;
    this.ignoredDirectories = new Set(
      (Array.isArray(ignoredDirectories) ? ignoredDirectories : [])
        .filter((value) => typeof value === 'string' && value.trim())
        .map(normalizeComparablePath),
    );
    this.cache = null;
  }

  #isIgnoredDirectory(value) {
    return this.ignoredDirectories.has(normalizeComparablePath(value));
  }

  #runtimeOptions(timeout = 30_000, maxBuffer = 4 * 1024 * 1024, cwd = null) {
    return {
      cwd: cwd || this.accountManager.activeHome(),
      env: {
        ...process.env,
        ...this.accountManager.activeEnvironment(),
        GROK_DISABLE_AUTOUPDATER: '1',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer,
    };
  }

  async #sessionDirectoryIndex() {
    const root = path.join(this.accountManager.activeGrokHome(), 'sessions');
    const result = new Map();
    const directories = new Map();
    let groups = [];
    try {
      groups = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { sessions: result, directories: [] };
      throw error;
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupPath = path.join(root, group.name);
      const cwd = decodeDirectoryLabel(group.name);
      if (this.#isIgnoredDirectory(cwd)) continue;
      let entries = [];
      try {
        entries = await fsp.readdir(groupPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
        const sessionPath = path.join(groupPath, entry.name);
        let updatedAt = 0;
        try {
          updatedAt = (await fsp.stat(sessionPath)).mtimeMs;
        } catch {
        }
        result.set(entry.name, {
          cwd,
          updatedAt,
        });
        directories.set(cwd, Math.max(directories.get(cwd) || 0, updatedAt));
      }
    }
    return {
      sessions: result,
      directories: [...directories.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd]) => cwd),
    };
  }

  async #existingDirectories(candidates) {
    const result = [];
    for (const candidate of candidates.slice(0, 40)) {
      try {
        if ((await fsp.stat(candidate)).isDirectory()) result.push(candidate);
      } catch {
      }
    }
    return result;
  }

  async list({ query = '', limit = 80, force = false } = {}) {
    const normalizedLimit = normalizeLimit(limit);
    const normalizedQuery = String(query ?? '').trim().toLowerCase();
    const accountId = this.accountManager.list().currentId;
    const cacheUsable = !force
      && this.cache
      && this.cache.accountId === accountId
      && Date.now() - this.cache.loadedAt < LIST_CACHE_MS;
    let sessions;
    if (cacheUsable) {
      sessions = this.cache.sessions;
    } else {
      const requestedLimit = Math.max(normalizedLimit, 200);
      const directoryIndex = await this.#sessionDirectoryIndex();
      const candidateDirectories = [
        this.accountManager.activeHome(),
        ...directoryIndex.directories,
      ].filter((value, index, all) => all.indexOf(value) === index);
      const existingDirectories = await this.#existingDirectories(candidateDirectories);
      const outputs = await Promise.allSettled(existingDirectories.map((cwd) => (
        this.execFileImpl(
          this.grokPath,
          ['sessions', 'list', '--limit', String(requestedLimit)],
          this.#runtimeOptions(30_000, 4 * 1024 * 1024, cwd),
        )
      )));
      const merged = new Map();
      for (const output of outputs) {
        if (output.status !== 'fulfilled') continue;
        for (const session of parseGrokSessionList(output.value.stdout)) {
          const previous = merged.get(session.id);
          if (!previous || (!previous.title && session.title)) merged.set(session.id, session);
        }
      }
      for (const [id, directory] of directoryIndex.sessions) {
        if (merged.has(id)) continue;
        merged.set(id, {
          id,
          createdAt: directory.updatedAt,
          updatedAt: directory.updatedAt,
          status: 'local',
          title: '',
          groupLabel: '',
        });
      }
      sessions = [...merged.values()].map((session) => {
        const directory = directoryIndex.sessions.get(session.id);
        return {
          ...session,
          title: localizeGrokSessionTitle(session.title, directory?.cwd || session.groupLabel),
          cwd: directory?.cwd || session.groupLabel || this.accountManager.activeHome(),
          updatedAt: directory?.updatedAt || session.updatedAt,
          accountId,
        };
      }).filter((session) => !this.#isIgnoredDirectory(session.cwd))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      this.cache = { accountId, loadedAt: Date.now(), sessions };
    }
    const filtered = normalizedQuery
      ? sessions.filter((session) => `${session.title}\n${session.cwd}\n${session.id}`.toLowerCase().includes(normalizedQuery))
      : sessions;
    return {
      accountId,
      total: filtered.length,
      sessions: filtered.slice(0, normalizedLimit),
    };
  }

  async preview(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!SESSION_ID_PATTERN.test(id)) throw new Error('无效的 Grok 会话 ID');
    const listed = await this.list({ limit: MAX_LIST_LIMIT });
    const session = listed.sessions.find((entry) => entry.id === id);
    if (!session) throw new Error('当前 Grok 账号中找不到该历史会话');
    const { stdout } = await this.execFileImpl(
      this.grokPath,
      ['export', id],
      this.#runtimeOptions(60_000, 16 * 1024 * 1024, session.cwd),
    );
    const raw = String(stdout ?? '');
    const truncated = raw.length > MAX_TRANSCRIPT_CHARS;
    const markdown = truncated ? raw.slice(0, MAX_TRANSCRIPT_CHARS) : raw;
    return {
      session,
      markdown,
      blocks: parseGrokTranscript(markdown),
      truncated,
    };
  }

  invalidate() {
    this.cache = null;
  }
}

export const createGrokHistoryManager = (options) => new GrokHistoryManager(options);
