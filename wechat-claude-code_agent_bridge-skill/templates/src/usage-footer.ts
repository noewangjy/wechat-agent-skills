/**
 * 用量 footer 构建器（Claude Code CLI 版）
 *
 * Claude Code 的 `result` 事件直接带 `total_cost_usd` 和 `usage`，所以成本**优先**用官方值，
 * 定价表仅作为 cost 缺失时的估算兜底（比如旧版 CLI 或 3P provider 不返回 cost）。
 *
 * 字段来源实测（2.1.89，`--output-format stream-json`）：
 *   result.usage = {
 *     input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
 *     service_tier, ...
 *   }
 *   result.total_cost_usd（1P Anthropic 账户下有值，3P 可能缺）
 *   result.modelUsage = { <modelName>: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, ... } }
 */

export interface ClaudeUsageSnapshot {
  inputTokens?: number;
  /** Claude Code 叫 cache_read_input_tokens，对应缓存命中 */
  cacheReadInputTokens?: number;
  /** Claude Code 叫 cache_creation_input_tokens，对应缓存写入 */
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  /** 官方直接给的成本（美元）。优先用这个。 */
  totalCostUsd?: number;
}

export interface UsageFooterOptions {
  usage?: ClaudeUsageSnapshot;
  durationMs: number;
  turnCount?: number;
  model?: string;
  serviceTier?: string;
}

/* ---------- formatting helpers ---------- */

export function formatTokenCount(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
  return String(v);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds - minutes * 60);
  return `${minutes}m${remain}s`;
}

function formatUSD(v: number): string {
  if (!isFinite(v) || v <= 0) return '$0';
  if (v >= 1) return `$${v.toFixed(3)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

/* ---------- Anthropic pricing ($/1M tokens, 公开价格，仅作估算兜底) ---------- */

interface ModelPricing {
  label: string;
  input: number;
  /** 读取缓存（cache_read）通常 10% 于 input */
  cachedInput: number;
  /** 写入缓存（cache_creation, 5m ephemeral）通常 125% 于 input；简化按 input 处理 */
  cacheWrite: number;
  output: number;
}

const PRICING_TABLE: { match: RegExp; price: ModelPricing }[] = [
  // Opus 4.x
  { match: /opus[-_]?4[-_]?7[-_]?1m/i, price: { label: 'Opus 4.7 (1M)', input: 30, cachedInput: 3, cacheWrite: 37.5, output: 150 } },
  { match: /opus[-_]?4[-_]?7/i,        price: { label: 'Opus 4.7',      input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 } },
  { match: /opus[-_]?4[-_]?6/i,        price: { label: 'Opus 4.6',      input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 } },
  { match: /opus[-_]?4/i,              price: { label: 'Opus 4',        input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 } },
  // Sonnet 4.x
  { match: /sonnet[-_]?4[-_]?7[-_]?1m/i, price: { label: 'Sonnet 4.7 (1M)', input: 6, cachedInput: 0.6, cacheWrite: 7.5, output: 30 } },
  { match: /sonnet[-_]?4[-_]?7/i,        price: { label: 'Sonnet 4.7',     input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { match: /sonnet[-_]?4[-_]?6/i,        price: { label: 'Sonnet 4.6',     input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { match: /sonnet[-_]?4/i,              price: { label: 'Sonnet 4',       input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  // Haiku 4.x
  { match: /haiku[-_]?4/i,               price: { label: 'Haiku 4',        input: 0.25, cachedInput: 0.025, cacheWrite: 0.3125, output: 1.25 } },
  // Legacy 3.x fallback
  { match: /opus[-_]?3/i,                price: { label: 'Opus 3',         input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 } },
  { match: /sonnet[-_]?3/i,              price: { label: 'Sonnet 3',       input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { match: /haiku[-_]?3/i,               price: { label: 'Haiku 3',        input: 0.25, cachedInput: 0.025, cacheWrite: 0.3125, output: 1.25 } },
];

/** 当前主流 Sonnet 价格作为未知模型的兜底 */
const DEFAULT_PRICING: ModelPricing = { label: '(default)', input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };

function lookupPricing(model: string | undefined): ModelPricing | null {
  if (!model) return null;
  const hit = PRICING_TABLE.find(p => p.match.test(model));
  return hit ? hit.price : null;
}

function estimateCost(usage: ClaudeUsageSnapshot, pricing: ModelPricing): number {
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const cachedRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  return (
    inTok * pricing.input +
    cachedRead * pricing.cachedInput +
    cacheWrite * pricing.cacheWrite +
    outTok * pricing.output
  ) / 1_000_000;
}

/* ---------- footer builder ---------- */

export function buildUsageFooter(opts: UsageFooterOptions): string {
  const lines: string[] = [];

  // Line 1: 📊 tokens + duration
  if (opts.usage) {
    const inp = formatTokenCount(opts.usage.inputTokens);
    const out = formatTokenCount(opts.usage.outputTokens);
    const cachedRead = formatTokenCount(opts.usage.cacheReadInputTokens);
    const cacheWrite = opts.usage.cacheCreationInputTokens ?? 0;
    const dur = formatDuration(opts.durationMs);

    let tokenLine = `— 📊 tokens: in ${inp} · out ${out} · cache ${cachedRead}↑`;
    if (cacheWrite > 0) {
      tokenLine += ` · ${formatTokenCount(cacheWrite)}↓`;
    }
    tokenLine += ` · ⏱ ${dur}`;

    const extras: string[] = [];
    if ((opts.turnCount ?? 0) > 0) {
      extras.push(`turns ${opts.turnCount}`);
    }
    if (opts.serviceTier?.trim() && opts.serviceTier.trim() !== 'standard') {
      extras.push(`tier ${opts.serviceTier.trim()}`);
    }
    if (extras.length) {
      tokenLine += ` · ${extras.join(' · ')}`;
    }

    lines.push(tokenLine);
  } else {
    lines.push(`— 📊 tokens unavailable · ⏱ ${formatDuration(opts.durationMs)}`);
  }

  // Line 2: 💰 cost
  const modelName = opts.model?.trim() || undefined;
  const exactPricing = lookupPricing(modelName);

  // 优先：官方 result.total_cost_usd
  if (typeof opts.usage?.totalCostUsd === 'number' && opts.usage.totalCostUsd >= 0) {
    const label = exactPricing ? exactPricing.label : (modelName ?? 'model');
    lines.push(`— 💰 ${label}: ${formatUSD(opts.usage.totalCostUsd)}`);
  } else if (opts.usage) {
    const pricing = exactPricing ?? DEFAULT_PRICING;
    const cost = estimateCost(opts.usage, pricing);
    const label = exactPricing ? exactPricing.label : (modelName ?? '(default)');
    const approx = exactPricing ? '~' : '~'; // 无官方 cost 时恒为估算
    lines.push(`— 💰 ${label}: ${approx}${formatUSD(cost)}`);
  } else if (modelName) {
    lines.push(`— 🤖 model: ${modelName}`);
  }

  return '\n\n' + lines.join('\n');
}
