import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexClient } from '../src/client.ts';
import { AgentSession } from '../src/session.ts';
import { formatTokens, usageSummary } from '../src/usage.ts';
import { fileURLToPath } from 'node:url';

async function setup(t: any) {
  const client = new CodexClient(process.execPath, [fileURLToPath(new URL('./mock-server.ts', import.meta.url))]);
  t.after(() => client.close());
  await client.initialize();
  const session = new AgentSession(client, '/tmp/project');
  await session.open();
  return { client, session };
}

test('model and effort selection are validated and sent on the next turn without losing the thread', async (t) => {
  const { session, client } = await setup(t);
  const threadId = session.threadId;
  assert.equal(session.displayModel, 'mock-balanced');
  await session.setModel('mock-deep');
  assert.equal(session.effectiveModel, 'mock-balanced');
  assert.equal(session.displayModel, 'mock-deep');
  assert.equal(session.displayEffort, 'high');
  assert.equal(session.settingsPending, true);
  await assert.rejects(session.setEffort('low'), /不支持/);
  await session.setEffort('max');
  await session.run('fast');
  const request = await client.request('inspect-turn');
  assert.equal(request.threadId, threadId);
  assert.equal(request.model, 'mock-deep');
  assert.equal(request.effort, 'max');
  assert.equal(session.effectiveModel, 'mock-deep');
  assert.equal(session.settingsPending, false);
  assert.equal(session.usage?.last.totalTokens, 5000);
  await session.run('wait');
  await assert.rejects(session.setModel('mock-balanced'), /任务结束/);
  await session.interrupt();
});

test('sessions are scoped by cwd/provider and history preserves chronological turns and paginated items', async () => {
  const calls: any[] = [];
  const fake = new EventEmitter() as any;
  fake.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'saved', modelProvider: 'deepseek-provider' }, model: 'deepseek-flash' };
    if (method === 'thread/list') return { data: [], nextCursor: 'next-thread' };
    if (method === 'thread/turns/list') return { data: [
      { id: 'newer', items: [{ id: 'reply', type: 'agentMessage', text: 'new' }], itemsView: 'full' },
      { id: 'older', items: [], itemsView: 'summary' },
    ], nextCursor: 'older-page' };
    if (method === 'thread/items/list') return params.cursor
      ? { data: [{ item: { id: 'second', type: 'agentMessage', text: 'old answer' } }], nextCursor: null }
      : { data: [{ item: { id: 'first', type: 'userMessage', content: [] } }], nextCursor: 'item-next' };
    throw new Error(method);
  };
  const session = new AgentSession(fake, '/project');
  await session.open();
  await session.listThreads('bug', 'page-2');
  const list = calls.find((call) => call.method === 'thread/list').params;
  assert.equal(list.cwd, '/project');
  assert.deepEqual(list.modelProviders, ['deepseek-provider']);
  assert.equal(list.searchTerm, 'bug');
  assert.equal(list.cursor, 'page-2');
  const history = await session.history();
  assert.deepEqual(history.turns.map((turn) => turn.id), ['older', 'newer']);
  assert.deepEqual(history.turns[0].items.map((item) => item.id), ['first', 'second']);
  assert.equal(history.nextCursor, 'older-page');
});

test('resuming restores persisted model and settings; pending choices do not leak across sessions', async (t) => {
  const { session } = await setup(t);
  await session.setModel('mock-deep');
  await session.open('thread-saved');
  assert.equal(session.displayModel, 'mock-balanced');
  assert.equal(session.settingsPending, false);
  assert.equal(session.displayEffort, 'medium');
  assert.equal(session.usage, undefined);
  const history = await session.history();
  assert.equal(history.turns[0].items[0].content[0].text, '历史消息：检查登录流程');
});

test('new sessions inherit selected model and effort instead of resetting effort to provider default', async (t) => {
  const { session, client } = await setup(t);
  await session.setModel('mock-deep');
  await session.setEffort('max');
  await session.open();
  assert.equal(session.effectiveModel, 'mock-deep');
  assert.equal(session.effectiveEffort, 'max');
  await session.run('fast');
  const request = await client.request('inspect-turn');
  // The thread config already owns the selected effort; subsequent turns inherit it.
  assert.equal(request.threadId, session.threadId);
  assert.equal(session.displayEffort, 'max');
});

test('usage uses the last request for context occupancy, never cumulative totals or double-counted detail', () => {
  const last = { totalTokens: 12000, inputTokens: 10000, outputTokens: 2000, cachedInputTokens: 4000, reasoningOutputTokens: 500 };
  const usage = { total: { ...last, totalTokens: 200000 }, last, modelContextWindow: 100000 };
  const summary = usageSummary(usage);
  assert.equal(summary.percent, 12);
  assert.match(summary.compact, /12%/);
  assert.match(summary.compact, /累计 200k/);
  assert.match(summary.detail, /不重复相加/);
  assert.equal(usageSummary({ ...usage, modelContextWindow: null }).percent, null);
  assert.match(usageSummary().compact, /等待后端/);
  assert.equal(formatTokens(1_000_000), '1m');
});

test('a thread held by another writer leaves the current session and pending choices intact', async () => {
  const fake = new EventEmitter() as any;
  fake.request = async (method: string) => {
    if (method === 'thread/start') return { thread: { id: 'current' }, model: 'model' };
    throw new Error('thread other already has an active writer');
  };
  const session = new AgentSession(fake, '/project');
  await session.open();
  await assert.rejects(session.open('other'), /其他 Codex 窗口/);
  assert.equal(session.threadId, 'current');
  assert.equal(session.effectiveModel, 'model');
});
