import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEEPSEEK_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekProfile = { version: 1; provider: 'deepseek'; apiKey: string; model: string };

export function validKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error('API Key 不能为空或包含空白字符');
  return key;
}
export function validModel(model: string) {
  if (!(DEEPSEEK_MODELS as readonly string[]).includes(model)) {
    throw new Error(`请选择支持的 DeepSeek 模型：${DEEPSEEK_MODELS.join('、')}`);
  }
  return model;
}
export const credentialPath = (stateDir: string) => join(stateDir, 'auth', 'deepseek.json');

export async function readProfile(stateDir: string): Promise<DeepSeekProfile | undefined> {
  let text: string;
  try { text = await readFile(credentialPath(stateDir), 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const value = JSON.parse(text);
    if (value.version !== 1 || value.provider !== 'deepseek' || typeof value.apiKey !== 'string') throw new Error();
    return { version: 1, provider: 'deepseek', apiKey: validKey(value.apiKey), model: validModel(value.model) };
  } catch { throw new Error('本地 DeepSeek 配置无效，请重新运行 login deepseek'); }
}

export async function saveProfile(stateDir: string, profile: DeepSeekProfile) {
  const validated = { version: 1, provider: 'deepseek', apiKey: validKey(profile.apiKey), model: validModel(profile.model) };
  const path = credentialPath(stateDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(validated, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function removeProfile(stateDir: string) {
  await unlink(credentialPath(stateDir)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

/** Validate authentication without an inference request or sending project data. */
export async function verifyDeepSeek(apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${DEEPSEEK_URL}/models`, {
    headers: { Authorization: `Bearer ${validKey(apiKey)}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'DeepSeek API Key 无效'
      : response.status === 402 ? 'DeepSeek 账户余额不足'
      : response.status === 429 ? 'DeepSeek 请求过于频繁，请稍后重试'
      : `DeepSeek 凭据验证失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  const body = await response.json() as { data?: { id: string }[] };
  const models = body.data?.map((item) => item.id).filter((id) => (DEEPSEEK_MODELS as readonly string[]).includes(id));
  if (!models?.length) throw new Error('DeepSeek 未返回可用的 Responses API 模型');
  return models;
}

/** Secrets travel only in the child environment, never argv or RPC configuration. */
export function runtimeOptions(profile?: DeepSeekProfile, catalogPath?: string, modelOverride?: string) {
  if (!profile) return { args: ['app-server'], env: { ...process.env }, model: modelOverride };
  const model = validModel(modelOverride ?? profile.model);
  const config: Record<string, string | boolean> = {
    model_provider: 'agent_cli_deepseek', model,
    'model_providers.agent_cli_deepseek.name': 'DeepSeek',
    'model_providers.agent_cli_deepseek.base_url': DEEPSEEK_URL,
    'model_providers.agent_cli_deepseek.env_key': 'AGENT_CLI_DEEPSEEK_API_KEY',
    'model_providers.agent_cli_deepseek.wire_api': 'responses',
    'model_providers.agent_cli_deepseek.requires_openai_auth': false,
    'model_providers.agent_cli_deepseek.supports_websockets': false,
    model_reasoning_effort: 'high', model_reasoning_summary: 'none', web_search: 'disabled',
    ...(catalogPath ? { model_catalog_json: catalogPath } : {}),
  };
  return {
    args: ['app-server', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
    env: { ...process.env, AGENT_CLI_DEEPSEEK_API_KEY: validKey(profile.apiKey) }, model,
  };
}

export function redact(text: string, ...secrets: (string | undefined)[]) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text;
}
