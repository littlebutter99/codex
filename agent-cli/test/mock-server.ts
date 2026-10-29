import { createInterface } from 'node:readline';
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
let initialized = false;
let lastTurn: any;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const m = JSON.parse(line);
  const result = (value: unknown) => send({ id: m.id, result: value });
  if (m.method === 'initialize') { result({ userAgent: 'mock' }); return; }
  if (m.method === 'initialized') { initialized = true; return; }
  if (!initialized) {
    send({ id: m.id, error: { code: -1, message: 'Not initialized' } }); return;
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    result({ thread: { id: m.params.threadId ?? 'thread-test', modelProvider: 'openai' }, model: m.params.model ?? 'mock-balanced', reasoningEffort: m.params.config?.model_reasoning_effort ?? 'medium' }); return;
  }
  if (m.method === 'model/list') {
    result({ data: [
      { id: 'mock-balanced', model: 'mock-balanced', displayName: 'Balanced Model', description: '适合日常任务', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'medium', description: '均衡' }] },
      { id: 'mock-deep', model: 'mock-deep', displayName: 'Deep Model', description: '复杂问题', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '深入' }, { reasoningEffort: 'max', description: '最高' }] },
    ], nextCursor: null }); return;
  }
  if (m.method === 'thread/list') {
    result({ data: [
      { id: 'thread-saved', name: '登录功能开发', preview: '检查登录流程', model: 'mock-balanced', modelProvider: 'openai', cwd: m.params.cwd, updatedAt: 1793000000 },
      { id: 'thread-test', name: '界面优化', preview: '优化终端布局', model: 'mock-deep', modelProvider: 'openai', cwd: m.params.cwd, updatedAt: 1793000001 },
    ].filter((thread) => !m.params.searchTerm || thread.name.includes(m.params.searchTerm)), nextCursor: null }); return;
  }
  if (m.method === 'thread/turns/list') {
    result({ data: [{ id: 'turn-history', status: 'completed', itemsView: 'full', items: [
      { id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: '历史消息：检查登录流程' }] },
      { id: 'history-agent', type: 'agentMessage', text: '历史回复：登录流程已检查，支持隐藏 Key 输入。' },
      { id: 'history-command', type: 'commandExecution', command: 'npm test', aggregatedOutput: '历史测试通过', status: 'completed', exitCode: 0 },
    ] }], nextCursor: null }); return;
  }
  if (m.method === 'inspect-turn') { result(lastTurn); return;
  }
  if (m.method === 'turn/start') {
    lastTurn = m.params;
    const params = { threadId: m.params.threadId, turn: { id: 'turn-test' } };
    send({ method: 'turn/started', params });
    if (m.params.input[0].text === 'fast') {
      send({ method: 'thread/tokenUsage/updated', params: { threadId: m.params.threadId, turnId: 'turn-test', tokenUsage: { total: {totalTokens:15000,inputTokens:12000,outputTokens:3000,cachedInputTokens:5000,reasoningOutputTokens:1000}, last:{totalTokens:5000,inputTokens:4000,outputTokens:1000,cachedInputTokens:2000,reasoningOutputTokens:500},modelContextWindow:100000 } } });
      send({ method: 'turn/completed', params: { ...params, turn: { id: 'turn-test', status: 'completed' } } });
    }
    result({ turn: { id: 'turn-test' } }); return;
  }
  if (m.method === 'turn/interrupt') {
    result({});
    send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } } });
    return;
  }
  if (m.method === 'echo') { setTimeout(() => result(m.params), m.params.delay ?? 0); return; }
  if (m.method === 'hang') return;
  if (m.method === 'die') { process.exit(9); }
  if (m.method === 'server-request') {
    send({ id: 'approval-test', method: 'item/commandExecution/requestApproval', params: { command: 'echo test' } });
    result({}); return;
  }
  if (m.id === 'approval-test') { send({ method: 'approval-result', params: m.result }); return; }
  send({ id: m.id, error: { code: -32601, message: 'Unknown method' } });
});
