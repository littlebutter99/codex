import { EventEmitter } from 'node:events';
import { CodexClient, type Message } from './client.ts';
import type { HistoryPage, HistoryTurn, ModelInfo, TokenUsage } from './types.ts';

export class AgentSession extends EventEmitter {
  threadId = '';
  turnId: string | null = null;
  effectiveModel = '';
  effectiveEffort: string | undefined;
  providerId = '';
  usage: TokenUsage | undefined;
  settingsPending = false;
  private chosenModel: string | undefined;
  private chosenEffort: string | undefined;
  private modelCache: ModelInfo[] | undefined;
  busy = false;
  private cancelRequested = false;
  readonly client: CodexClient;
  readonly cwd: string;
  readonly model?: string;

  constructor(client: CodexClient, cwd: string, model?: string) {
    super();
    this.client = client;
    this.cwd = cwd;
    this.model = model;
    client.on('notification', (message: Message) => {
      const p = message.params ?? {};
      if (p.threadId && p.threadId !== this.threadId) return;
      if (message.method === 'thread/tokenUsage/updated') this.usage = p.tokenUsage;
      if (message.method === 'model/rerouted' && p.toModel) this.effectiveModel = p.toModel;
      if (message.method === 'turn/started') {
        this.turnId = p.turn.id;
        if (this.cancelRequested) void this.interrupt().catch((e) => this.emit('failure', e));
      }
      if (message.method === 'turn/completed') {
        this.busy = false;
        this.turnId = null;
        this.cancelRequested = false;
      }
      this.emit('notification', message);
    });
    client.on('disconnect', (error) => this.emit('disconnect', error));
  }

  async open(threadId?: string) {
    if (this.busy) throw new Error('当前任务尚未结束');
    const model = threadId ? this.model : this.chosenModel ?? (this.effectiveModel || this.model);
    const effort = threadId ? undefined : this.displayEffort;
    const params = {
      cwd: this.cwd,
      ...(model ? { model } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
    };
    let result;
    try {
      result = await this.client.request(threadId ? 'thread/resume' : 'thread/start', {
        ...params, ...(threadId ? { threadId, excludeTurns: true } : {}),
      });
    } catch (error) {
      if ((error as Error).message.includes('active writer')) throw new Error('该会话正在其他 Codex 窗口中使用。请关闭对应窗口后再恢复；当前会话保持不变。');
      throw error;
    }
    this.threadId = result.thread.id;
    this.effectiveModel = result.model ?? this.model ?? '后端默认模型';
    this.effectiveEffort = result.reasoningEffort ?? result.thread.reasoningEffort ?? undefined;
    this.providerId = result.thread.modelProvider ?? this.providerId;
    this.chosenModel = undefined;
    this.chosenEffort = undefined;
    this.settingsPending = false;
    this.usage = undefined;
    this.modelCache = undefined;
    return this.threadId;
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    const models: ModelInfo[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('模型列表分页游标重复');
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.modelCache = models;
    return models;
  }

  async setModel(name: string) {
    if (this.busy) throw new Error('请等待当前任务结束后切换模型');
    const models = await this.models();
    const model = models.find((item) => item.model === name || item.id === name);
    if (!model) throw new Error('当前提供商未返回该模型');
    this.chosenModel = model.model;
    const supported = model.supportedReasoningEfforts ?? [];
    const current = this.chosenEffort ?? this.effectiveEffort;
    this.chosenEffort = supported.some((option) => option.reasoningEffort === current)
      ? current : model.defaultReasoningEffort;
    this.settingsPending = true;
  }

  async setEffort(effort: string) {
    if (this.busy) throw new Error('请等待当前任务结束后调整思考强度');
    const model = (await this.models()).find((item) => item.model === this.displayModel);
    if (!model?.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)) {
      throw new Error('当前模型不支持该思考强度');
    }
    this.chosenEffort = effort;
    this.settingsPending = true;
  }

  get displayModel() { return this.chosenModel ?? this.effectiveModel; }
  get displayEffort() { return this.chosenEffort ?? this.effectiveEffort; }

  listThreads(searchTerm = '', cursor?: string) {
    return this.client.request('thread/list', {
      cwd: this.cwd, ...(this.providerId ? { modelProviders: [this.providerId] } : {}),
      sortKey: 'updated_at', sortDirection: 'desc', limit: 30,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      ...(searchTerm ? { searchTerm } : {}), ...(cursor ? { cursor } : {}),
    });
  }

  async history(cursor?: string, threadId = this.threadId): Promise<HistoryPage> {
    const page = await this.client.request('thread/turns/list', {
      threadId, limit: 15, sortDirection: 'desc', itemsView: 'full',
      ...(cursor ? { cursor } : {}),
    });
    const turns: HistoryTurn[] = [];
    for (const turn of [...page.data].reverse()) {
      if (turn.itemsView === 'full') { turns.push(turn); continue; }
      const items: any[] = [];
      let itemCursor: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await this.client.request('thread/items/list', {
          threadId, turnId: turn.id, sortDirection: 'asc', limit: 100,
          ...(itemCursor ? { cursor: itemCursor } : {}),
        });
        items.push(...response.data.map((entry: any) => entry.item));
        itemCursor = response.nextCursor ?? undefined;
        if (itemCursor && seen.has(itemCursor)) throw new Error('历史消息分页游标重复');
        if (itemCursor) seen.add(itemCursor);
      } while (itemCursor);
      turns.push({ ...turn, items, itemsView: 'full' });
    }
    return { turns, nextCursor: page.nextCursor ?? null };
  }

  async run(text: string) {
    if (this.busy) throw new Error('任务执行中，请用 /cancel 取消后再输入');
    this.busy = true;
    this.cancelRequested = false;
    try {
      const result = await this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(this.chosenModel ? { model: this.chosenModel } : {}),
        ...(this.chosenEffort ? { effort: this.chosenEffort } : {}),
      });
      this.effectiveModel = this.chosenModel ?? this.effectiveModel;
      this.effectiveEffort = this.chosenEffort ?? this.effectiveEffort;
      this.settingsPending = false;
      // A fast turn may complete before the response arrives.
      if (this.busy) {
        this.turnId = result.turn.id;
        if (this.cancelRequested) await this.interrupt();
      }
    } catch (error) {
      this.busy = false;
      this.turnId = null;
      throw error;
    }
  }

  async interrupt() {
    if (!this.busy) return;
    this.cancelRequested = true;
    if (this.turnId) await this.client.request('turn/interrupt', {
      threadId: this.threadId, turnId: this.turnId,
    });
  }
}
