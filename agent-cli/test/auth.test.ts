import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialPath, readProfile, saveProfile, removeProfile, runtimeOptions, verifyDeepSeek, redact } from '../src/auth.ts';
import { deepSeekLogin } from '../src/login.ts';

const profile = { version: 1, provider: 'deepseek', apiKey: 'sk-test-only-not-a-real-key', model: 'deepseek-flash' } as const;

test('credentials round-trip in a private directory and can be removed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-cli-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readProfile(dir), undefined);
  await saveProfile(dir, profile);
  assert.deepEqual(await readProfile(dir), profile);
  assert.equal((await stat(credentialPath(dir))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'auth'))).mode & 0o777, 0o700);
  await assert.rejects(saveProfile(dir, { ...profile, model: 'wrong-model' }), /请选择/);
  assert.deepEqual(JSON.parse(await readFile(credentialPath(dir), 'utf8')), profile);
  await removeProfile(dir);
  assert.equal(await readProfile(dir), undefined);
});

test('DeepSeek runtime keeps key out of argv and uses Responses with a local catalog', () => {
  const runtime = runtimeOptions(profile, '/tmp/models.json');
  assert.equal(runtime.model, 'deepseek-flash');
  assert.equal(runtime.env.AGENT_CLI_DEEPSEEK_API_KEY, profile.apiKey);
  assert.ok(!JSON.stringify(runtime.args).includes(profile.apiKey));
  assert.ok(runtime.args.includes('model_providers.agent_cli_deepseek.wire_api="responses"'));
  assert.ok(runtime.args.includes('model_providers.agent_cli_deepseek.supports_websockets=false'));
  assert.ok(runtime.args.includes('model_catalog_json="/tmp/models.json"'));
  assert.ok(runtime.args.includes('web_search="disabled"'));
  assert.equal(runtimeOptions(undefined).args.length, 1);
  assert.throws(() => runtimeOptions(profile, undefined, 'gpt-other'), /请选择/);
  assert.equal(redact(`error ${profile.apiKey}`, profile.apiKey), 'error [REDACTED]');
});

test('login verification uses only the fixed DeepSeek models endpoint, not inference', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: any, options: any) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, `Bearer ${profile.apiKey}`);
    assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
  }) as typeof fetch;
  assert.deepEqual(await verifyDeepSeek(profile.apiKey, undefined, fetcher), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(calls, ['https://api.deepseek.com/models']);
  const denied = (async () => new Response('sensitive error body', { status: 401 })) as typeof fetch;
  await assert.rejects(verifyDeepSeek(profile.apiKey, undefined, denied), /API Key 无效/);
});

test('login asks for a secret then chooses a verified model; cancellation saves nothing', async () => {
  const seen: any[] = [];
  const responses = [profile.apiKey, '2'];
  const verify = async () => ['deepseek-flash', 'deepseek-v4-pro'];
  const result = await deepSeekLogin(async (text, _signal, options) => {
    seen.push({ text, options }); return responses.shift()!;
  }, new AbortController().signal, undefined, verify);
  assert.equal(seen[0].options.secret, true);
  assert.equal(seen[1].options.cancelReject, true);
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(JSON.stringify(seen).includes(profile.apiKey), false);
  const controller = new AbortController();
  await assert.rejects(deepSeekLogin(async () => '', controller.signal, undefined, verify), /取消登录/);
});

test('aborted validation cannot continue to model selection or return credentials', async () => {
  const controller = new AbortController();
  let prompts = 0;
  const verify = async () => { controller.abort(); return ['deepseek-flash']; };
  await assert.rejects(deepSeekLogin(async () => { prompts++; return profile.apiKey; }, controller.signal, undefined, verify));
  assert.equal(prompts, 1);
});
