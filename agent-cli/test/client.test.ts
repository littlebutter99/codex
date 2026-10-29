import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../src/client.ts';
import { AgentSession } from '../src/session.ts';
import { answerRequest, ApprovalQueue } from '../src/approvals.ts';

const fixture = fileURLToPath(new URL('./mock-server.ts', import.meta.url));
async function setup(t: any) {
  const client = new CodexClient(process.execPath, [fixture]);
  t.after(() => client.close());
  await client.initialize();
  return client;
}

test('handshake precedes work; response IDs handle out-of-order replies', async (t) => {
  const client = await setup(t);
  const results = await Promise.all([
    client.request('echo', { value: 'slow', delay: 30 }),
    client.request('echo', { value: 'fast', delay: 0 }),
  ]);
  assert.equal(results[0].value, 'slow');
  assert.equal(results[1].value, 'fast');
  await assert.rejects(client.request('unknown'), /Unknown method/);
  await assert.rejects(client.request('hang', {}, 30), /timed out/);
});

test('server requests are answered separately from outbound responses', async (t) => {
  const client = await setup(t);
  const queue = new ApprovalQueue(client, async () => 'y', assert.fail);
  client.on('request', (message) => queue.enqueue(message));
  const notification = once(client, 'notification');
  await client.request('server-request');
  const [message] = await notification;
  assert.equal(message.method, 'approval-result');
  assert.deepEqual(message.params, { decision: 'accept' });
});

test('session resumes, prevents overlapping turns and handles fast completion', async (t) => {
  const client = await setup(t);
  const session = new AgentSession(client, '/tmp');
  assert.equal(await session.open('saved-thread'), 'saved-thread');
  await session.open();
  await session.run('fast');
  assert.equal(session.busy, false);
  assert.equal(session.turnId, null);
  await session.run('wait');
  await assert.rejects(session.run('overlap'), /任务执行中/);
  const done = once(session, 'notification');
  await session.interrupt();
  await done;
  // Flush remaining stdout lines after the interrupt response.
  if (session.busy) await once(session, 'notification');
  assert.equal(session.busy, false);
});

test('backend termination rejects pending RPCs', async (t) => {
  const client = await setup(t);
  await assert.rejects(client.request('die'), /Codex exited/);
  await assert.rejects(client.request('echo'), /closed/);
});

test('approvals default to decline and permissions require explicit consent', async () => {
  const signal = new AbortController().signal;
  for (const answer of ['', 'yes please', '普通聊天', 'n']) {
    assert.deepEqual(await answerRequest({ method: 'item/fileChange/requestApproval', params: {} }, async () => answer, signal), { decision: 'decline' });
  }
  const request = { method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } };
  assert.deepEqual(await answerRequest(request, async () => 'n', signal), { permissions: {}, scope: 'turn' });
  assert.deepEqual(await answerRequest(request, async () => 'y', signal), { permissions: request.params.permissions, scope: 'turn' });
});

test('resolved approvals abort active prompts and skip queued requests', async () => {
  const responded: unknown[] = [];
  const fake = { respond: (...args: unknown[]) => responded.push(args) } as unknown as CodexClient;
  let prompts = 0;
  const queue = new ApprovalQueue(fake, (_text, signal) => new Promise((_resolve, reject) => {
    prompts++;
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), assert.fail);
  queue.enqueue({ id: 1, method: 'item/fileChange/requestApproval' });
  queue.enqueue({ id: 2, method: 'item/fileChange/requestApproval' });
  await new Promise((resolve) => setImmediate(resolve));
  queue.resolve(1);
  queue.resolve(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts, 1);
  assert.equal(responded.length, 0);
});
