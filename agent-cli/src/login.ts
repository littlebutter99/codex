import { DEEPSEEK_MODELS, validKey, validModel, verifyDeepSeek, type DeepSeekProfile } from './auth.ts';

export type LoginPrompt = (text: string, signal: AbortSignal, options?: { secret?: boolean; title?: string; cancelReject?: boolean }) => Promise<string>;

export async function deepSeekLogin(
  ask: LoginPrompt, signal: AbortSignal, preferredModel?: string,
  verify: typeof verifyDeepSeek = verifyDeepSeek,
): Promise<DeepSeekProfile> {
  const key = await ask('输入 DeepSeek API Key\n在 platform.deepseek.com 创建 Key。\n输入内容不会显示；Esc 取消。', signal, { secret: true, title: '登录 DeepSeek', cancelReject: true });
  if (!key.trim()) throw new Error('已取消登录');
  const apiKey = validKey(key);
  const available = await verify(apiKey, signal);
  signal.throwIfAborted();
  const models = DEEPSEEK_MODELS.filter((model) => available.includes(model));
  let model = preferredModel;
  if (model) validModel(model);
  else {
    const choice = await ask(`选择模型\n${models.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n输入编号或模型名称，回车默认 ${models[0]}。`, signal, { title: '选择 DeepSeek 模型', cancelReject: true });
    model = models[Number(choice.trim()) - 1] ?? (choice.trim() || models[0]);
  }
  if (!available.includes(model)) throw new Error('当前账户未返回所选模型');
  return { version: 1, provider: 'deepseek', apiKey, model: validModel(model) };
}
