import type { TokenUsage } from './types.ts';

export function formatTokens(value: number) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return Math.round(value).toLocaleString('en-US');
}

/** Last-request tokens approximate occupied context; cumulative usage does not. */
export function usageSummary(usage?: TokenUsage) {
  if (!usage) return { compact: 'Token — · 等待后端用量', detail: '后端尚未返回 Token 用量。', percent: null };
  const { last, total, modelContextWindow: window } = usage;
  const percent = window && window > 0 ? Math.min(100, Math.max(0, last.totalTokens / window * 100)) : null;
  return {
    compact: `${percent === null ? '上下文 —' : `上下文约 ${Math.round(percent)}%`} · ${formatTokens(last.totalTokens)}${window ? ` / ${formatTokens(window)}` : ''} · 累计 ${formatTokens(total.totalTokens)}`,
    percent,
    detail: [
      '最近一轮', `  输入 ${formatTokens(last.inputTokens)} · 输出 ${formatTokens(last.outputTokens)}`,
      `  缓存命中 ${formatTokens(last.cachedInputTokens)} · 推理输出 ${formatTokens(last.reasoningOutputTokens)}`,
      '', '会话累计', `  总计 ${formatTokens(total.totalTokens)} · 输入 ${formatTokens(total.inputTokens)} · 输出 ${formatTokens(total.outputTokens)}`,
      '', `上下文窗口 ${window ? formatTokens(window) : '未提供'} · 当前占用为最近请求的近似值。`,
      '缓存和推理用量是输入/输出的细分，不重复相加。金额未估算。',
    ].join('\n'),
  };
}
