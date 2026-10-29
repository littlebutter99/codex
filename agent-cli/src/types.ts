export type ModelInfo = {
  id: string; model: string; displayName: string; description?: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort?: string; isDefault?: boolean;
};
export type ThreadInfo = {
  id: string; name?: string | null; preview: string; cwd: string;
  model?: string | null; modelProvider: string; updatedAt: number;
  status?: { type: string };
};
export type HistoryTurn = { id: string; items: any[]; itemsView?: string; status?: string };
export type HistoryPage = { turns: HistoryTurn[]; nextCursor: string | null };
export type TokenBreakdown = {
  totalTokens: number; inputTokens: number; cachedInputTokens: number;
  cacheWriteInputTokens?: number; outputTokens: number; reasoningOutputTokens: number;
};
export type TokenUsage = { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow: number | null };
