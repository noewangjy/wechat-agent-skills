/**
 * 微信 ilink 长轮询 + Claude Code CLI (`claude -p --output-format stream-json`) 桥接。
 *
 * 目标：
 * - 支持文字、图片、文件消息转发给 Claude Code
 * - 使用 session_id 续接会话
 * - 忙时把新消息作为追问缓冲，完成后继续同一上下文
 * - 允许微信侧切换模型和 permission-mode
 *
 * 限制：
 * - 采用 `claude -p` 非交互模式，因此不支持像 Cursor 版那样对每次工具调用做微信逐条审批
 * - 执行权限由 permission-mode + allowedTools/disallowedTools 统一控制
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

import {
  loadBridgeConfig,
  TEMPLATES_ROOT,
  CONFIG_PATH,
  isValidPermissionMode,
  type BridgeConfig,
  type ClaudePermissionMode,
} from './config.js';
import { getUpdates, sendMessage, sendFile } from './ilink.js';
import type { Credentials, WeixinMessage } from './types.js';
import { materializeInboundMessage, type InboundPayload } from './inbound-media.js';
import { buildUsageFooter, type ClaudeUsageSnapshot } from './usage-footer.js';

const CREDENTIALS_PATH = path.join(TEMPLATES_ROOT, 'credentials.json');
const STATE_PATH = path.join(TEMPLATES_ROOT, 'bridge-state.json');
const INBOUND_DIR = path.join(TEMPLATES_ROOT, '.media_cache', 'inbound');
const FOLLOWUP_DIR = path.join(TEMPLATES_ROOT, '.media_cache', 'followups');

const MAX_QUEUE_SIZE = 10;
const FOLLOWUP_FILENAME = '.bridge-followup.md';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SEND_FILE_RE = /\[SEND_FILE:([^\]]+)\]/g;

interface BridgeState {
  get_updates_buf: string;
  /** per-user 最近活跃的 Claude Code session ID + 时间 */
  sessions: Record<string, { sessionId: string; lastActivity: number }>;
}

function loadState(): BridgeState {
  if (!fs.existsSync(STATE_PATH)) {
    return { get_updates_buf: '', sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as BridgeState;
  } catch {
    return { get_updates_buf: '', sessions: {} };
  }
}

function saveState(state: BridgeState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function loadCredentials(): Credentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`缺少 ${CREDENTIALS_PATH}，请先 npm run setup`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8')) as Credentials;
}

function persistConfigPatch(patch: Partial<BridgeConfig>): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      console.error('[bridge] 解析 bridge.config.json 失败，将以空对象覆盖:', e);
    }
  }
  Object.assign(raw, patch);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

async function safeSend(
  cred: Credentials,
  userId: string,
  token: string,
  text: string,
): Promise<boolean> {
  try {
    const resp = await sendMessage(cred, userId, token, text) as { ret?: number; errmsg?: string };
    if (resp.ret !== undefined && resp.ret !== 0) {
      console.error(`[bridge] sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[bridge] sendMessage error:', e);
    return false;
  }
}

async function safeSendLong(
  cred: Credentials,
  userId: string,
  token: string,
  text: string,
  maxLen: number,
): Promise<boolean> {
  if (!text) return false;
  for (let i = 0; i < text.length; i += maxLen) {
    const ok = await safeSend(cred, userId, token, text.slice(i, i + maxLen));
    if (!ok) return false;
  }
  return true;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function terminateChildProcess(proc: ChildProcess | null | undefined, forceAfterMs = 3000): Promise<boolean> {
  if (!proc || proc.exitCode !== null) return false;

  const pid = proc.pid;

  try {
    if (pid) {
      process.kill(-pid, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}

  const deadline = Date.now() + forceAfterMs;
  while (proc.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }

  if (proc.exitCode !== null) return true;

  try {
    if (pid) {
      process.kill(-pid, 'SIGKILL');
    } else {
      proc.kill('SIGKILL');
    }
  } catch {}

  return true;
}

function truncateForLog(text: string, limit = 200): string {
  return text.replace(/\s+/g, ' ').slice(0, limit);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    result.push(p);
  }
  return result;
}

function normalizePermissionArg(raw: string): ClaudePermissionMode | null {
  const t = raw.trim();
  if (!t) return null;
  // 允许用户写常见别名
  const alias: Record<string, ClaudePermissionMode> = {
    ro: 'plan',
    readonly: 'plan',
    'read-only': 'plan',
    edits: 'acceptEdits',
    accept: 'acceptEdits',
    bypass: 'bypassPermissions',
    danger: 'bypassPermissions',
    full: 'bypassPermissions',
  };
  const lower = t.toLowerCase();
  if (alias[lower]) return alias[lower];
  return isValidPermissionMode(t) ? t : null;
}

interface PendingMsg {
  prompt: string;
  contextToken: string;
  /** 传给 Claude 时附加到 prompt 里的图片路径（Claude Code 无 --image flag，走 Read 工具） */
  imagePaths: string[];
}

interface UserContext {
  proc: ChildProcess | null;
  contextToken: string;
  queue: PendingMsg[];
  followUpBuffer: PendingMsg[];
  killed: boolean;
}

/* ============ Claude Code stream-json 事件类型 ============ */

interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  permissionMode?: string;
}

interface AssistantMessageEvent {
  type: 'assistant';
  message?: {
    id?: string;
    model?: string;
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
      | { type: string; [k: string]: unknown }
    >;
    stop_reason?: string | null;
    usage?: ClaudeUsageRaw;
  };
  session_id?: string;
}

interface UserMessageEvent {
  type: 'user';
  message?: {
    content?: Array<
      | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
      | { type: string; [k: string]: unknown }
    >;
  };
  session_id?: string;
}

interface ResultEvent {
  type: 'result';
  subtype?: 'success' | 'error_during_execution' | string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string | null;
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsageRaw;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
  errors?: string[];
}

interface ClaudeUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

type ClaudeEvent =
  | SystemInitEvent
  | AssistantMessageEvent
  | UserMessageEvent
  | ResultEvent
  | { type: string; [k: string]: unknown };

const BRIDGE_CAPABILITY_HINT = [
  '[系统提示：你正通过微信桥接与用户对话。',
  '当用户要求发送文件、图片、音频或视频给微信时，在回复中使用 [SEND_FILE:/绝对路径] 标记，桥接会自动上传。',
  '路径必须是服务器上已存在的绝对路径，单文件不超过25MB。',
  `用户在你执行任务期间发来的追问会实时写入工作区根目录的 ${FOLLOWUP_FILENAME} 文件。`,
  '在做重要决策、开始较长操作、或怀疑用户有补充说明时，请优先读取该文件。]',
].join(' ');

function buildPromptText(inbound: InboundPayload): string {
  const lines: string[] = [];

  if (inbound.text) {
    lines.push(inbound.text);
  }

  if (inbound.imageParts.length) {
    lines.push(
      '',
      '[用户发送了图片，已保存到以下路径，请使用 Read 工具打开查看：]',
    );
    for (const image of inbound.imageParts) {
      lines.push(`- ${image.savedPath}`);
    }
  }

  if (inbound.savedPaths.length) {
    lines.push('', '[用户发送的附件已保存到本地，请按需读取以下路径]');
    for (const savedPath of inbound.savedPaths) {
      lines.push(`- ${savedPath}`);
    }
  }

  lines.push('', BRIDGE_CAPABILITY_HINT);
  return lines.join('\n').trim() || '(空消息)';
}

function buildFollowUpPrompt(followUps: PendingMsg[]): string {
  const lines: string[] = [
    '[用户在你执行上一个任务期间发来了以下追问或补充信息，请结合之前的工作一并处理：]',
    '',
  ];

  for (let i = 0; i < followUps.length; i++) {
    lines.push(`--- 追问 ${i + 1} ---`);
    lines.push(followUps[i].prompt.replace(BRIDGE_CAPABILITY_HINT, '').trim());
    lines.push('');
  }

  lines.push(BRIDGE_CAPABILITY_HINT);
  return lines.join('\n').trim();
}

function buildFollowUpFileContent(followUps: PendingMsg[]): string {
  const lines = [
    '# 用户追问（实时更新）',
    '',
    '> 以下是用户在当前任务执行期间发来的补充信息，请在做重要决策前参考。',
    '',
  ];

  for (let i = 0; i < followUps.length; i++) {
    lines.push(`## 追问 ${i + 1}`);
    lines.push('');
    lines.push(followUps[i].prompt.replace(BRIDGE_CAPABILITY_HINT, '').trim());
    lines.push('');
  }

  return lines.join('\n');
}

function writeFollowUpFile(userId: string, followUps: PendingMsg[], workspaceCwd?: string) {
  const content = buildFollowUpFileContent(followUps);

  try {
    fs.mkdirSync(FOLLOWUP_DIR, { recursive: true });
    const fp = path.join(FOLLOWUP_DIR, `${userId.slice(0, 16)}.md`);
    fs.writeFileSync(fp, content, 'utf-8');
    console.log(`[bridge] 追问缓存已更新: ${fp} (${followUps.length} 条)`);
  } catch (e) {
    console.error('[bridge] 写追问缓存失败:', e);
  }

  if (workspaceCwd) {
    try {
      const fp = path.join(workspaceCwd, FOLLOWUP_FILENAME);
      fs.writeFileSync(fp, content, 'utf-8');
      console.log(`[bridge] workspace 追问文件已更新: ${fp}`);
    } catch (e) {
      console.error('[bridge] 写 workspace 追问文件失败:', e);
    }
  }
}

function clearFollowUpFile(userId: string, workspaceCwd?: string) {
  try {
    const fp = path.join(FOLLOWUP_DIR, `${userId.slice(0, 16)}.md`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    // ignore
  }

  if (workspaceCwd) {
    try {
      const fp = path.join(workspaceCwd, FOLLOWUP_FILENAME);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // ignore
    }
  }
}

/* ---------- usage extraction ---------- */

function extractUsageFromRaw(raw: ClaudeUsageRaw | undefined): ClaudeUsageSnapshot | undefined {
  if (!raw) return undefined;
  const snap: ClaudeUsageSnapshot = {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheReadInputTokens: raw.cache_read_input_tokens,
    cacheCreationInputTokens: raw.cache_creation_input_tokens,
  };
  return Object.values(snap).some(v => v !== undefined) ? snap : undefined;
}

function extractUsageFromResult(ev: ResultEvent): ClaudeUsageSnapshot | undefined {
  // 优先使用 modelUsage（非零字段更完整），再回落到 usage，再把 total_cost_usd 合并进去
  let snap: ClaudeUsageSnapshot | undefined;

  if (ev.modelUsage) {
    for (const [, mu] of Object.entries(ev.modelUsage)) {
      const candidate: ClaudeUsageSnapshot = {
        inputTokens: mu.inputTokens,
        outputTokens: mu.outputTokens,
        cacheReadInputTokens: mu.cacheReadInputTokens,
        cacheCreationInputTokens: mu.cacheCreationInputTokens,
      };
      if (Object.values(candidate).some(v => typeof v === 'number' && v > 0)) {
        snap = candidate;
        break;
      }
    }
  }

  if (!snap) snap = extractUsageFromRaw(ev.usage);
  if (!snap) snap = {};

  if (typeof ev.total_cost_usd === 'number') snap.totalCostUsd = ev.total_cost_usd;
  return Object.keys(snap).length ? snap : undefined;
}

function mergeUsage(
  prev: ClaudeUsageSnapshot | undefined,
  next: ClaudeUsageSnapshot | undefined,
): ClaudeUsageSnapshot | undefined {
  if (!prev) return next;
  if (!next) return prev;
  return {
    inputTokens: next.inputTokens ?? prev.inputTokens,
    outputTokens: next.outputTokens ?? prev.outputTokens,
    cacheReadInputTokens: next.cacheReadInputTokens ?? prev.cacheReadInputTokens,
    cacheCreationInputTokens: next.cacheCreationInputTokens ?? prev.cacheCreationInputTokens,
    totalCostUsd: next.totalCostUsd ?? prev.totalCostUsd,
  };
}

async function main() {
  const cfg = loadBridgeConfig();
  const credentials = loadCredentials();
  const state = loadState();
  const userContexts = new Map<string, UserContext>();
  let shuttingDown = false;

  function getOrCreateCtx(userId: string, contextToken: string): UserContext {
    let ctx = userContexts.get(userId);
    if (!ctx) {
      ctx = { proc: null, contextToken, queue: [], followUpBuffer: [], killed: false };
      userContexts.set(userId, ctx);
    }
    ctx.contextToken = contextToken;
    return ctx;
  }

  console.log(
    `[bridge] 已启动 - cwd=${cfg.cwd} model=${cfg.model || '(default)'} permissionMode=${cfg.permissionMode}`,
  );

  async function runClaudeCodeCli(
    prompt: string,
    userId: string,
    contextToken: string,
    _imagePaths: string[],
    resumeSessionId?: string,
  ): Promise<string | undefined> {
    const ctx = getOrCreateCtx(userId, contextToken);

    // Claude Code CLI 没有 --image 参数。图片走 prompt 里的路径 + Read 工具，
    // 见 buildPromptText —— 路径已经写进 prompt 了。

    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (cfg.bareMode) args.push('--bare');
    if (cfg.model.trim()) args.push('--model', cfg.model.trim());

    if (cfg.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', cfg.permissionMode);
    }

    if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools);
    if (cfg.disallowedTools.length) args.push('--disallowedTools', ...cfg.disallowedTools);

    for (const addDir of cfg.addDirs) {
      args.push('--add-dir', addDir);
    }

    if (resumeSessionId) {
      // --resume 与 --no-session-persistence 互斥；这里让 CLI 持久化以便后续续接
      args.push('--resume', resumeSessionId);
    }

    // prompt 作为 positional argument（Claude Code CLI 的标准方式）
    args.push(prompt);

    console.log(
      `[claude] 启动 user=${userId.slice(0, 12)}... ${
        resumeSessionId ? `resume=${resumeSessionId.slice(0, 8)}...` : `new session`
      } mode=${cfg.permissionMode} prompt=${truncateForLog(prompt, 120)}`,
    );

    let proc: ChildProcess;
    try {
      proc = spawn(cfg.claudeCodePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cfg.cwd,
        detached: true,
      });
    } catch (e) {
      throw new Error(`无法启动 claude：${(e as Error).message}`);
    }

    if (!proc.stdout) {
      throw new Error('claude 进程未提供 stdout，无法读取 JSON 事件流');
    }

    ctx.proc = proc;
    ctx.killed = false;

    let resultSessionId = resumeSessionId;
    let stderr = '';
    let timedOut = false;
    let turnCompleted = false;
    let isError = false;
    let usage: ClaudeUsageSnapshot | undefined;
    let observedModel = cfg.model.trim() || undefined;
    let serviceTier: string | undefined;
    let lastAssistantText = '';
    let finalResultText = '';
    let toolUseCount = 0;
    let numTurns = 0;
    let errorMessage = '';
    const startedAt = Date.now();
    let spawnError = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.once('error', (err) => {
      spawnError = err.message;
      console.error('[claude] process error:', err);
    });

    const timeout = setTimeout(async () => {
      timedOut = true;
      ctx.killed = true;
      const elapsedMin = Math.round(cfg.agentTimeoutMs / 60000);
      console.warn(`[bridge] Claude 运行超时 (${elapsedMin}min)，终止进程`);

      const partial = (finalResultText || lastAssistantText).trim();
      const notice = partial
        ? `⏰ Claude 运行超过 ${elapsedMin} 分钟，已自动终止。以下是已产生的部分结果：\n\n${partial}`
        : `⏰ Claude 运行超过 ${elapsedMin} 分钟，已自动终止。请拆成更小的任务重试。`;
      await safeSendLong(credentials, userId, contextToken, notice, cfg.maxMessageLength);

      await terminateChildProcess(proc, 5000);
    }, cfg.agentTimeoutMs);

    try {
      const rl = readline.createInterface({ input: proc.stdout! });

      for await (const line of rl) {
        if (!line.trim()) continue;

        let event: ClaudeEvent;
        try {
          event = JSON.parse(line) as ClaudeEvent;
        } catch {
          continue;
        }

        if (event.type === 'system' && (event as SystemInitEvent).subtype === 'init') {
          const sys = event as SystemInitEvent;
          resultSessionId = sys.session_id;
          if (sys.model) observedModel = sys.model;
          console.log(`[claude] session=${resultSessionId?.slice(0, 8)}... model=${sys.model ?? '?'}`);
          continue;
        }

        if (event.type === 'assistant') {
          const asst = event as AssistantMessageEvent;
          const content = asst.message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && typeof (block as { text: string }).text === 'string') {
              const text = (block as { text: string }).text.trim();
              if (text) {
                lastAssistantText = text;
                if (cfg.verbose) console.log(`[claude] msg> ${truncateForLog(text)}`);
              }
            } else if (block.type === 'tool_use') {
              toolUseCount++;
              const name = (block as { name?: string }).name ?? '?';
              console.log(`[claude] tool> ${name}`);
            }
          }
          usage = mergeUsage(usage, extractUsageFromRaw(asst.message?.usage));
          if (asst.message?.model && !observedModel) observedModel = asst.message.model;
          continue;
        }

        if (event.type === 'user') {
          // tool_result 回流，通常不需要特别处理
          continue;
        }

        if (event.type === 'result') {
          const res = event as ResultEvent;
          turnCompleted = true;
          isError = Boolean(res.is_error);
          if (res.session_id) resultSessionId = res.session_id;
          if (typeof res.num_turns === 'number') numTurns = res.num_turns;
          if (res.usage?.service_tier) serviceTier = res.usage.service_tier;
          usage = mergeUsage(usage, extractUsageFromResult(res));
          if (typeof res.result === 'string' && res.result.trim()) {
            finalResultText = res.result.trim();
          }
          if (res.errors?.length) {
            errorMessage = res.errors.join('; ');
          }
          continue;
        }
      }

      await new Promise<void>((resolve) => {
        proc.on('close', () => resolve());
        if (proc.exitCode !== null) resolve();
      });

      const durationMs = Date.now() - startedAt;

      if (turnCompleted && !timedOut && !ctx.killed && !isError) {
        const replyBody = finalResultText || lastAssistantText;
        const cleaned = await extractAndSendFiles(replyBody, userId, contextToken);
        const footer = cfg.showTokenUsage
          ? buildUsageFooter({
              usage,
              durationMs,
              turnCount: numTurns,
              model: observedModel,
              serviceTier,
            })
          : '';
        const finalText = cleaned.trim() ? cleaned + footer : footer.trim();
        if (finalText) {
          await safeSendLong(credentials, userId, contextToken, finalText, cfg.maxMessageLength);
        }
        console.log(`[claude] 完成 tools=${toolUseCount} turns=${numTurns} duration=${durationMs}ms`);
      } else if (!timedOut && !ctx.killed) {
        const detail = spawnError || errorMessage || stderr.trim() || `exit=${proc.exitCode}`;
        await safeSend(credentials, userId, contextToken, `❌ Claude 执行失败: ${detail.slice(0, 500)}`);
      }

      if (proc.exitCode !== null && proc.exitCode !== 0 && !timedOut && !ctx.killed) {
        console.error(`[claude] 退出码=${proc.exitCode} stderr=${stderr.slice(0, 500)}`);
      }
    } finally {
      clearTimeout(timeout);
      ctx.proc = null;
      await terminateChildProcess(proc, 1000);
    }

    return resultSessionId;
  }

  async function processTask(userId: string, prompt: string, contextToken: string, imagePaths: string[]) {
    const sessionRec = state.sessions[userId];
    const resumeSessionId =
      cfg.enableSession &&
      sessionRec &&
      Date.now() - sessionRec.lastActivity < cfg.sessionTimeoutMs
        ? sessionRec.sessionId
        : undefined;

    const newSessionId = await runClaudeCodeCli(prompt, userId, contextToken, imagePaths, resumeSessionId);
    if (newSessionId) {
      state.sessions[userId] = { sessionId: newSessionId, lastActivity: Date.now() };
      saveState(state);
    }
  }

  async function drainFollowUps(userId: string, ctx: UserContext) {
    if (ctx.followUpBuffer.length === 0) return;

    const followUps = ctx.followUpBuffer.splice(0);
    const lastToken = followUps[followUps.length - 1].contextToken;
    const mergedPrompt = buildFollowUpPrompt(followUps);
    const mergedImages = dedupePaths(followUps.flatMap(item => item.imagePaths));
    clearFollowUpFile(userId, cfg.cwd);

    console.log(`[bridge] 处理 ${followUps.length} 条追问 (user=${userId.slice(0, 12)}...)`);

    try {
      await safeSend(credentials, userId, lastToken, `💬 开始处理 ${followUps.length} 条追问，续接同一对话上下文...`);
      await processTask(userId, mergedPrompt, lastToken, mergedImages);
    } catch (e) {
      console.error('[bridge] 处理追问失败:', e);
      await safeSend(credentials, userId, lastToken, `❌ 处理追问出错: ${String(e).slice(0, 500)}`);
    }

    if (ctx.followUpBuffer.length > 0) {
      await drainFollowUps(userId, ctx);
    }
  }

  async function drainQueue(userId: string, firstPrompt: string, firstToken: string, firstImages: string[]) {
    const ctx = getOrCreateCtx(userId, firstToken);

    try {
      if (cfg.sendThinkingHint) {
        await safeSend(credentials, userId, firstToken, cfg.thinkingHintText);
      }
      await processTask(userId, firstPrompt, firstToken, firstImages);
    } catch (e) {
      console.error('[bridge] processTask error:', e);
      await safeSend(credentials, userId, firstToken, `❌ 处理出错: ${String(e).slice(0, 500)}`);
    }

    await drainFollowUps(userId, ctx);

    while (ctx.queue.length > 0) {
      const next = ctx.queue.shift()!;
      console.log(`[bridge] 处理队列消息 (user=${userId.slice(0, 12)}..., 剩余 ${ctx.queue.length} 条)`);

      try {
        await safeSend(
          credentials,
          userId,
          next.contextToken,
          `📋 开始处理排队消息: "${next.prompt.slice(0, 50)}${next.prompt.length > 50 ? '...' : ''}"`,
        );
        await processTask(userId, next.prompt, next.contextToken, next.imagePaths);
      } catch (e) {
        console.error('[bridge] queue processTask error:', e);
        await safeSend(credentials, userId, next.contextToken, `❌ 处理出错: ${String(e).slice(0, 500)}`);
      }

      await drainFollowUps(userId, ctx);
    }

    ctx.proc = null;
  }

  async function killAgent(ctx: UserContext, forceAfterMs = 3000): Promise<boolean> {
    if (!ctx.proc || ctx.proc.exitCode !== null) return false;
    ctx.killed = true;
    const killed = await terminateChildProcess(ctx.proc, forceAfterMs);
    if (killed) {
      console.log('[bridge] 已终止当前 Claude 进程');
    }
    return killed;
  }

  async function shutdownBridge(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] 收到 ${signal}，准备重启/退出，开始清理子进程...`);

    for (const [userId, ctx] of userContexts.entries()) {
      if (ctx.followUpBuffer.length > 0) {
        writeFollowUpFile(userId, ctx.followUpBuffer, cfg.cwd);
      }
    }
    saveState(state);

    await Promise.all([...userContexts.values()].map(ctx => killAgent(ctx, 1000)));
    process.exit(0);
  }

  process.once('SIGINT', () => {
    void shutdownBridge('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdownBridge('SIGTERM');
  });

  async function handleSendFile(userId: string, contextToken: string, filePath: string) {
    if (!filePath) {
      await sendMessage(credentials, userId, contextToken, '用法：/send <文件路径>');
      return;
    }

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cfg.cwd, filePath);
    if (!fs.existsSync(resolved)) {
      await sendMessage(credentials, userId, contextToken, `❌ 文件不存在: ${resolved}`);
      return;
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      await sendMessage(credentials, userId, contextToken, `❌ 不是文件: ${resolved}`);
      return;
    }

    if (stat.size > MAX_FILE_SIZE) {
      await sendMessage(
        credentials,
        userId,
        contextToken,
        `❌ 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，微信限制约 25MB。`,
      );
      return;
    }

    try {
      await sendFile(credentials, userId, contextToken, resolved);
      console.log(`[bridge] 文件发送成功: ${resolved}`);
    } catch (e) {
      console.error('[bridge] sendFile error:', e);
      await sendMessage(credentials, userId, contextToken, `❌ 文件发送失败: ${String(e).slice(0, 300)}`);
    }
  }

  async function extractAndSendFiles(text: string, userId: string, contextToken: string): Promise<string> {
    const matches = [...text.matchAll(SEND_FILE_RE)];
    if (!matches.length) return text;

    for (const match of matches) {
      const filePath = match[1].trim();
      await handleSendFile(userId, contextToken, filePath);
    }

    return text.replace(SEND_FILE_RE, '').trim();
  }

  async function handleStatus(userId: string, contextToken: string, ctx: UserContext) {
    const sessionRec = state.sessions[userId];
    const permStr = cfg.dangerouslySkipPermissions
      ? 'dangerously-skip (所有检查跳过)'
      : cfg.permissionMode;
    const lines = [
      '当前 bridge 状态：',
      `- cwd: ${cfg.cwd}`,
      `- claudeCodePath: ${cfg.claudeCodePath}`,
      `- model: ${cfg.model || '(default)'}`,
      `- permission: ${permStr}`,
      `- allowedTools: ${cfg.allowedTools.length ? cfg.allowedTools.join(', ') : '(none)'}`,
      `- disallowedTools: ${cfg.disallowedTools.length ? cfg.disallowedTools.join(', ') : '(none)'}`,
      `- bareMode: ${cfg.bareMode}`,
      `- session: ${cfg.enableSession ? 'on' : 'off'}`,
      `- 当前 session: ${sessionRec?.sessionId ?? '(none)'}`,
      `- 任务状态: ${ctx.proc ? '处理中' : '空闲'}`,
      `- 追问数: ${ctx.followUpBuffer.length}`,
      `- 队列数: ${ctx.queue.length}`,
    ];
    await safeSendLong(credentials, userId, contextToken, lines.join('\n'), cfg.maxMessageLength);
  }

  async function handleOneMessage(msg: WeixinMessage) {
    if (msg.message_type !== 1) return;
    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    if (cfg.allowedUserIds.length && !cfg.allowedUserIds.includes(userId)) {
      return;
    }

    const inbound = await materializeInboundMessage(msg, credentials, INBOUND_DIR);
    const text = inbound.text.trim();

    console.log(
      `[bridge] 收到消息 user=${userId.slice(0, 12)}... text="${truncateForLog(text, 80)}" images=${inbound.imageParts.length} files=${inbound.savedPaths.length}`,
    );

    if (!text && !inbound.imageParts.length && !inbound.savedPaths.length) {
      return;
    }

    const imagePaths = inbound.imageParts.map(item => item.savedPath).filter(Boolean);
    const ctx = getOrCreateCtx(userId, contextToken);
    const isBusy = ctx.proc !== null;

    if (text === '/help') {
      await safeSend(
        credentials,
        userId,
        contextToken,
        [
          '命令：',
          '  /help                          - 帮助',
          '  /status                        - 查看 bridge 状态',
          '  /clear                         - 清空会话 + 队列 + 追问',
          '  /stop                          - 终止当前任务',
          '  /stopall                       - 终止当前任务并清空队列 + 追问',
          '  /send <路径>                   - 发送服务器上的文件到微信',
          '  /model                         - 查看当前模型',
          '  /model <名称>                  - 设置模型（如 sonnet / opus / claude-sonnet-4-6）',
          '  /model clear                   - 恢复默认模型',
          '  /permission                    - 查看当前 permission-mode',
          '  /permission default            - 只读提示模式',
          '  /permission acceptEdits        - 自动批准编辑 + 常用 bash',
          '  /permission plan               - 只读分析',
          '  /permission auto               - 自动执行（需账户支持）',
          '  /permission dontAsk            - 仅预批准工具',
          '  /permission bypassPermissions  - 完全跳过（仅信任目录）',
          '',
          '直接发送文字、图片、文件即可交给 Claude Code 处理。',
          '忙时新消息默认作为追问，任务完成后会续接到同一对话上下文。',
          `用 /排队 前缀可将消息作为独立任务排队（最多 ${MAX_QUEUE_SIZE} 条）。`,
          '',
          '注意：本桥接不支持微信逐条审批工具调用；请用 /permission + allowedTools 控制权限。',
        ].join('\n'),
      );
      return;
    }

    if (text === '/status') {
      await handleStatus(userId, contextToken, ctx);
      return;
    }

    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice(6).trim();
      if (!arg) {
        await safeSend(
          credentials,
          userId,
          contextToken,
          [
            `当前模型：${cfg.model || '(Claude Code 默认)'}`,
            '',
            '用法：',
            '  /model <名称>    - 设置模型（sonnet / opus / claude-sonnet-4-6 等）',
            '  /model clear     - 恢复默认模型',
          ].join('\n'),
        );
        return;
      }

      if (arg === 'clear' || arg === 'default' || arg === 'reset') {
        cfg.model = '';
        persistConfigPatch({ model: '' });
        await safeSend(credentials, userId, contextToken, '✅ 已恢复 Claude Code 默认模型。下一轮执行生效。');
        return;
      }

      cfg.model = arg;
      persistConfigPatch({ model: arg });
      await safeSend(
        credentials,
        userId,
        contextToken,
        `✅ 模型已切换为 ${arg}。${isBusy ? '当前正在执行的任务不受影响。' : '下一轮执行立即生效。'}`,
      );
      return;
    }

    if (text === '/permission' || text.startsWith('/permission ')) {
      const arg = text.slice('/permission'.length).trim();
      if (!arg) {
        await safeSend(
          credentials,
          userId,
          contextToken,
          [
            `当前 permission-mode：${cfg.permissionMode}${cfg.dangerouslySkipPermissions ? ' (被 dangerously-skip-permissions 覆盖)' : ''}`,
            '',
            '用法：',
            '  /permission default',
            '  /permission acceptEdits',
            '  /permission plan',
            '  /permission auto',
            '  /permission dontAsk',
            '  /permission bypassPermissions',
          ].join('\n'),
        );
        return;
      }

      const mode = normalizePermissionArg(arg);
      if (!mode) {
        await safeSend(
          credentials,
          userId,
          contextToken,
          '⚠️ 非法模式。合法值：default / acceptEdits / plan / auto / dontAsk / bypassPermissions',
        );
        return;
      }

      cfg.permissionMode = mode;
      delete state.sessions[userId];
      saveState(state);
      persistConfigPatch({ permissionMode: mode });
      await safeSend(
        credentials,
        userId,
        contextToken,
        `✅ permission-mode 已切换为 ${mode}。已重置当前用户的续接会话，下一轮将以新会话启动。${isBusy ? '\n如需立刻生效，请先 /stop 当前任务。' : ''}`,
      );
      return;
    }

    if (text === '/clear') {
      ctx.queue.length = 0;
      ctx.followUpBuffer.length = 0;
      clearFollowUpFile(userId, cfg.cwd);
      await killAgent(ctx);
      delete state.sessions[userId];
      saveState(state);
      await safeSend(credentials, userId, contextToken, '✅ 已清除会话、终止任务、清空队列和追问。');
      return;
    }

    if (text === '/stop') {
      if (isBusy) {
        await killAgent(ctx);
        await safeSend(credentials, userId, contextToken, '⏹ 已终止当前任务。');
      } else {
        await safeSend(credentials, userId, contextToken, '当前没有正在执行的任务。');
      }
      return;
    }

    if (text === '/stopall') {
      const qLen = ctx.queue.length;
      const fLen = ctx.followUpBuffer.length;
      ctx.queue.length = 0;
      ctx.followUpBuffer.length = 0;
      clearFollowUpFile(userId, cfg.cwd);
      await killAgent(ctx);
      await safeSend(
        credentials,
        userId,
        contextToken,
        `⏹ 已终止当前任务${qLen || fLen ? `并清空 ${qLen} 条排队、${fLen} 条追问` : ''}。`,
      );
      return;
    }

    if (text.startsWith('/send ')) {
      const filePath = text.slice(6).trim();
      await handleSendFile(userId, contextToken, filePath);
      return;
    }

    const canReply = !cfg.replyAllowedUserIds.length || cfg.replyAllowedUserIds.includes(userId);
    if (!canReply) {
      await safeSend(credentials, userId, contextToken, cfg.replyDeniedMessage);
      return;
    }

    const isExplicitQueue = text.startsWith('/排队');
    const effectiveInbound = isExplicitQueue
      ? { ...inbound, text: text.slice(3).trim() }
      : inbound;
    const prompt = buildPromptText(effectiveInbound);
    const effectiveImagePaths = isExplicitQueue
      ? effectiveInbound.imageParts.map(item => item.savedPath).filter(Boolean)
      : imagePaths;

    if (isBusy) {
      const totalPending = ctx.followUpBuffer.length + ctx.queue.length;
      if (totalPending >= MAX_QUEUE_SIZE) {
        await safeSend(
          credentials,
          userId,
          contextToken,
          `⚠️ 待处理已满 (${MAX_QUEUE_SIZE} 条)。请等待当前任务完成，或使用 /stop /stopall 清理。`,
        );
        return;
      }

      if (isExplicitQueue) {
        ctx.queue.push({ prompt, contextToken, imagePaths: effectiveImagePaths });
        await safeSend(credentials, userId, contextToken, `📋 已作为独立任务排队 (#${ctx.queue.length})。`);
      } else {
        ctx.followUpBuffer.push({ prompt, contextToken, imagePaths: effectiveImagePaths });
        writeFollowUpFile(userId, ctx.followUpBuffer, cfg.cwd);
        await safeSend(
          credentials,
          userId,
          contextToken,
          `💬 已收到追问 (#${ctx.followUpBuffer.length})，已写入 ${FOLLOWUP_FILENAME}，当前任务完成后会续接处理。`,
        );
      }
      return;
    }

    void drainQueue(userId, prompt, contextToken, effectiveImagePaths);
  }

  console.log('[bridge] 进入长轮询循环，等待微信消息...');
  let pollCount = 0;

  while (!shuttingDown) {
    try {
      const resp = await getUpdates(credentials, state.get_updates_buf);
      if (resp.get_updates_buf) state.get_updates_buf = resp.get_updates_buf;
      pollCount++;

      const msgCount = resp.msgs?.length ?? 0;
      if (msgCount > 0) {
        console.log(`[bridge] 轮询 #${pollCount}: 收到 ${msgCount} 条消息`);
      } else if (pollCount % 20 === 0) {
        console.log(`[bridge] 轮询 #${pollCount}: 在线，暂无新消息`);
      }

      for (const msg of resp.msgs ?? []) {
        await handleOneMessage(msg);
      }

      saveState(state);
    } catch (e) {
      if (shuttingDown) break;
      console.error('[bridge] getUpdates error:', e);
      await sleep(3000);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
