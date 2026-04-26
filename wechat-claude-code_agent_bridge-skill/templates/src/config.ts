/**
 * 桥接配置（bridge.config.json + 默认值）
 * 运行后端为 Claude Code CLI（`claude -p --output-format stream-json`）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_ROOT = path.join(__dirname, '..');
export const CONFIG_PATH = path.join(TEMPLATES_ROOT, 'bridge.config.json');
export const EXAMPLE_CONFIG_PATH = path.join(TEMPLATES_ROOT, 'bridge.config.example.json');

/**
 * Claude Code CLI 的 --permission-mode 合法值
 * 来源：`claude --help`（2.1.89）
 */
export type ClaudePermissionMode =
  | 'default'           // 仅读取，每个写操作都提示（非交互式下基本=只读）
  | 'acceptEdits'       // 自动批准编辑 + 常用 bash
  | 'plan'              // 只读分析模式
  | 'auto'              // 自动执行（需满足账户条件）
  | 'dontAsk'           // 仅执行预批准工具，其他自动拒绝
  | 'bypassPermissions'; // 跳过所有检查（仅在信任目录使用）

export interface BridgeConfig {
  cwd: string;
  claudeCodePath: string;
  model: string;
  permissionMode: ClaudePermissionMode;

  /** Claude Code --allowedTools，留空表示不限制。示例：["Bash(git:*)", "Edit", "Read"] */
  allowedTools: string[];
  /** Claude Code --disallowedTools */
  disallowedTools: string[];
  /** 若为 true，传 --dangerously-skip-permissions（比 permissionMode=bypassPermissions 更强） */
  dangerouslySkipPermissions: boolean;
  /** --bare：跳过全局 MCP / CLAUDE.md / hooks / OAuth / keychain 等自动发现。
   *  默认 false 以便桥接直接继承用户已经在 `claude mcp add` 配置好的全局 MCP server、
   *  ~/.claude/CLAUDE.md 等。若希望桥接跑在最小隔离环境下（CI、共享机器），再设为 true。 */
  bareMode: boolean;

  addDirs: string[];
  agentTimeoutMs: number;

  maxMessageLength: number;
  enableSession: boolean;
  sessionTimeoutMs: number;

  sendThinkingHint: boolean;
  thinkingHintText: string;
  verbose: boolean;
  showTokenUsage: boolean;

  allowedUserIds: string[];
  replyAllowedUserIds: string[];
  replyDeniedMessage: string;
}

const VALID_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

export const defaultConfig: BridgeConfig = {
  cwd: '',
  claudeCodePath: 'claude',
  model: '',
  permissionMode: 'acceptEdits',

  allowedTools: [],
  disallowedTools: [],
  dangerouslySkipPermissions: false,
  bareMode: false,

  addDirs: [],
  agentTimeoutMs: 30 * 60 * 1000,

  maxMessageLength: 4000,
  enableSession: true,
  sessionTimeoutMs: 30 * 60 * 1000,

  sendThinkingHint: true,
  thinkingHintText: '✅ 已收到，正在调用 Claude Code 处理...',
  verbose: false,
  showTokenUsage: true,

  allowedUserIds: [],
  replyAllowedUserIds: [],
  replyDeniedMessage: '⚠️ 您没有查看回复的权限。请联系管理员将您的 ID 加入白名单。',
};

function normalizePermissionMode(value: unknown): ClaudePermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim() as ClaudePermissionMode;
  return (VALID_PERMISSION_MODES as readonly string[]).includes(t) ? t : undefined;
}

/**
 * 当 claudeCodePath 不是绝对路径时，通过 `which` 解析其完整路径。
 * 解决 npm scripts / spawn 子进程中 PATH 查找失败（ENOENT）的问题。
 */
function resolveExecPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  try {
    const resolved = execSync(`which ${raw}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (resolved) return resolved;
  } catch {}
  return raw;
}

/**
 * 解析 cwd：空值 / 相对路径 → 基于 TEMPLATES_ROOT 展开为绝对路径；
 * 目录不存在时回退到 TEMPLATES_ROOT 并打印警告。
 */
function resolveCwd(raw: string): string {
  if (!raw) return TEMPLATES_ROOT;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(TEMPLATES_ROOT, raw);
  if (fs.existsSync(abs)) return abs;
  console.warn(`[config] cwd "${abs}" 不存在，回退到项目目录: ${TEMPLATES_ROOT}`);
  return TEMPLATES_ROOT;
}

function filterStringArray(raw: unknown, fallback: string[]): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : fallback;
}

export function loadBridgeConfig(): BridgeConfig {
  let partial: Partial<BridgeConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      partial = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Partial<BridgeConfig>;
    } catch (e) {
      console.error('[config] 解析 bridge.config.json 失败，使用默认配置:', e);
    }
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    console.warn('[config] 未找到 bridge.config.json，从 bridge.config.example.json 读取（建议复制并改名为 bridge.config.json）');
    try {
      partial = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8')) as Partial<BridgeConfig>;
    } catch {
      // ignore
    }
  }

  const merged = { ...defaultConfig, ...partial };
  merged.claudeCodePath = resolveExecPath(merged.claudeCodePath);
  merged.cwd = resolveCwd(merged.cwd);
  merged.permissionMode = normalizePermissionMode(partial.permissionMode) ?? defaultConfig.permissionMode;
  merged.allowedTools = filterStringArray(partial.allowedTools, defaultConfig.allowedTools);
  merged.disallowedTools = filterStringArray(partial.disallowedTools, defaultConfig.disallowedTools);
  merged.addDirs = filterStringArray(partial.addDirs, defaultConfig.addDirs);
  return merged;
}

export function isValidPermissionMode(value: string): value is ClaudePermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(value);
}
