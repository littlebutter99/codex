import { parseArgs } from 'node:util';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient, type Message } from './client.ts';
import { Backend } from './backend.ts';
import { readProfile, saveProfile, removeProfile, runtimeOptions, redact, validKey, validModel, type DeepSeekProfile } from './auth.ts';
import { deepSeekLogin } from './login.ts';
import { AgentUI, clean } from './ui.ts';
import type { ThreadInfo } from './types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const runCommand = process.env.DICODE_PACKAGED === '1' ? 'dicode' : 'npm start --';
const help = `Dicode — pi-tui + Codex app-server

运行: ${runCommand} [--cwd 项目路径] [--model 模型] [--resume ID | --continue]
      ${runCommand} --check
      ${runCommand} --demo
      ${runCommand} login deepseek [--model deepseek-flash]

选项:
  --codex 路径   指定二进制（默认 vendor/codex，也可用 CODEX_BIN）
  --provider     deepseek 或 codex；默认使用已保存的 DeepSeek 配置
  --check        检查 app-server 握手，不调用模型
  --demo         界面演示，不启动 Codex 或调用模型

交互命令:
  /login         登录 DeepSeek，立即切换到新会话
  /logout        删除本地 DeepSeek 凭据，切回 Codex 配置
  /help          查看帮助
  /new           新建会话
  /resume ID     恢复会话
  /sessions      搜索并恢复当前项目的会话
  /history       加载更早的历史消息
  /model         选择模型，也可 /model 模型名称
  /effort        调整思考强度，也可 /effort high
  /usage         查看 Token 用量详情
  /status        查看工作目录、模型和当前会话
  /cancel        取消任务（Esc / Ctrl+C）
  /exit          退出（空闲时 Ctrl+C）

Enter 发送 · Alt+Enter 换行 · Tab 补全 · ↑ 输入历史 · 鼠标滚轮查看记录
审批只有输入 y 才允许；回车或 Esc 拒绝。`;

async function demo(cwd: string) {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行 --demo');
  const ui = new AgentUI(cwd);
  ui.setContext('demo-session', '界面演示 · 未连接模型');
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  let promptController: AbortController | undefined;
  ui.onExit = done;
  ui.onInterrupt = () => { promptController?.abort(); ui.setBusy(false, '已取消'); };
  let demoModel = 'deepseek-flash', demoEffort = 'high', demoThread = 'demo-session';
  const context = () => ui.setContext(demoThread, `演示 · ${demoModel}`, demoEffort);
  ui.onSubmit = (text) => {
    void (async () => {
      const command = text.trim();
      if (command === '/exit') { done(); return; }
      if (promptController && !promptController.signal.aborted) return;
      ui.clearEditor();
      if (command === '/model') {
        const item = await ui.select({ title: '模型 / 演示', subtitle: '离线界面预览 · 不连接模型服务', items: [
          { value: 'deepseek-flash', label: 'DeepSeek Flash', description: '快速响应 · 支持 low / high / max', current: demoModel === 'deepseek-flash' },
          { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: '复杂任务 · 支持 low / high / max', current: demoModel === 'deepseek-v4-pro' },
        ] });
        if (item) { demoModel = item.value; context(); }
      } else if (command === '/effort') {
        const item = await ui.select({ title: '思考强度 / 演示', subtitle: '按任务复杂程度选择推理深度', items: [
          { value: 'low', label: 'low', description: '轻量思考，优先响应速度', current: demoEffort === 'low' },
          { value: 'high', label: 'high', description: '深入思考，处理复杂问题', current: demoEffort === 'high' },
          { value: 'max', label: 'max', description: '最高推理深度', current: demoEffort === 'max' },
        ] });
        if (item) { demoEffort = item.value; context(); }
      } else if (command === '/sessions') {
        const item = await ui.select({ title: '继续工作 / 演示', subtitle: '当前项目 · 演示会话', items: [
          { value: 'demo-session', label: '构建终端 Agent 工作台', description: '今天 14:30 · deepseek-flash · 3 轮对话', current: demoThread === 'demo-session' },
          { value: 'demo-history', label: '检查登录与凭据管理', description: '昨天 17:20 · deepseek-v4-pro · 5 轮对话', current: demoThread === 'demo-history' },
        ] });
        if (item?.value === 'demo-history') {
          demoThread = item.value; demoModel = 'deepseek-v4-pro'; demoEffort = 'high';
          ui.resetConversation(); context();
          ui.loadHistory([{ id: 'demo-old', items: [
            { id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: '检查登录流程，确保 Key 不显示在终端。' }] },
            { id: 'old-agent', type: 'agentMessage', text: '### 登录流程检查\n\nKey 使用隐藏输入，凭据存放在本地私有文件中。\n\n这是**离线历史回显演示**，没有读取真实会话。' },
          ] }]);
        }
      } else if (command === '/usage') ui.notice('离线演示数据\n\n' + ui.usageDetails());
      else if (command === '/approval') {
        promptController = new AbortController();
        try {
          const answer = await ui.ask('演示审批\n命令: npm test\n这是界面演示，不会执行任何命令。\n允许本次操作？[y/N]', promptController.signal);
          ui.notice(answer.trim().toLowerCase() === 'y' ? '演示：已允许' : '演示：已拒绝');
        } catch { ui.notice('演示：审批已取消'); }
        finally { promptController = undefined; }
      } else {
        ui.user(text);
        ui.notice('离线演示：/sessions 会话 · /model 模型 · /effort 思考强度 · /usage 用量 · /approval 审批 · /exit 退出。');
      }
    })().catch((error) => ui.notice(error.message, true));
  };
  ui.start();
  ui.user('帮我检查测试，并解释这个 CLI 的架构。');
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'demo-message', type: 'agentMessage',
    text: '### 一个界面，完整的 Agent 执行\n\n前端由 **pi-tui** 渲染，后端继续调用官方 Codex 二进制。\n\n- `client.ts` 管理双向 RPC\n- `session.ts` 管理持续会话\n- `ui.ts` 展示对话、工具和审批\n\n```ts\nspawn(binary, ["app-server"]);\n```',
  } } });
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'demo-command', type: 'commandExecution', command: 'npm test',
    aggregatedOutput: '✔ RPC 通信\n✔ 会话与取消\n✔ 审批队列\n\n演示数据 · 未实际运行测试', status: 'completed', exitCode: 0,
  } } });
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'demo-diff', type: 'fileChange', status: 'completed', changes: [{
      path: '示例 / ui.ts（演示，未修改）', diff: '- readline 输入\n+ pi-tui 多行编辑器\n+ Markdown 对话与审批弹窗',
    }],
  } } });
  context();
  const sample = { totalTokens: 32000, inputTokens: 29000, outputTokens: 3000, cachedInputTokens: 12000, reasoningOutputTokens: 1500 };
  ui.setUsage({ total: { ...sample, totalTokens: 128000 }, last: sample, modelContextWindow: 1048576 });
  ui.notice('离线演示 · 用量为示例数据。输入 /sessions、/model、/effort 或 /approval 预览面板。');
  const onSignal = () => done();
  process.once('SIGTERM', onSignal);
  try { await finished; }
  finally { promptController?.abort(); ui.stop(); process.removeListener('SIGTERM', onSignal); }
}

async function standaloneLogin(stateDir: string, cwd: string, model?: string) {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行 login deepseek');
  const ui = new AgentUI(cwd);
  const controller = new AbortController();
  ui.setContext('', 'DeepSeek 登录');
  ui.onExit = () => controller.abort();
  ui.onInterrupt = () => controller.abort();
  const terminate = () => controller.abort();
  process.once('SIGTERM', terminate);
  ui.start();
  try {
    const profile = await deepSeekLogin((text, signal, options) => ui.ask(text, signal, options), controller.signal, model);
    controller.signal.throwIfAborted();
    await saveProfile(stateDir, profile);
    ui.stop();
    console.log(`DeepSeek 凭据已验证并保存，默认模型：${profile.model}。运行 ${runCommand} 开始使用。`);
  } finally { ui.stop(); process.removeListener('SIGTERM', terminate); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string' }, model: { type: 'string' }, resume: { type: 'string' },
    codex: { type: 'string' }, continue: { type: 'boolean' }, demo: { type: 'boolean' },
    provider: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.resume && values.continue) throw new Error('--resume 与 --continue 只能使用一个');
  if (values.provider && !['deepseek', 'codex'].includes(values.provider)) throw new Error('--provider 只支持 deepseek 或 codex');
  const cwd = resolve(values.cwd ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error(`不是目录: ${cwd}`);
  const stateDir = process.env.DICODE_STATE_DIR ? resolve(process.env.DICODE_STATE_DIR) : join(root, '.state');
  if (positionals.length) {
    if (positionals[0] !== 'login' || positionals.length > 2 || (positionals[1] && positionals[1] !== 'deepseek')) {
      throw new Error(`用法：${runCommand} login deepseek [--model deepseek-flash]`);
    }
    await standaloneLogin(stateDir, cwd, values.model); return;
  }
  if (values.demo) { await demo(cwd); return; }
  const binary = values.codex ?? process.env.CODEX_BIN ?? join(root, 'vendor', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (binary.includes('/')) await access(binary, constants.X_OK).catch(() => {
    throw new Error(`Codex 二进制不存在或不可执行: ${binary}。参见 README.md 下载步骤。`);
  });
  let profile = values.provider === 'codex' ? undefined : await readProfile(stateDir);
  if (!profile && values.provider === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error(`请先运行 ${runCommand} login deepseek，或设置 DEEPSEEK_API_KEY`);
    profile = { version: 1, provider: 'deepseek', apiKey: validKey(process.env.DEEPSEEK_API_KEY), model: validModel(values.model ?? 'deepseek-flash') };
  }
  const catalogPath = join(root, 'config', 'deepseek-models.json');
  const secrets = new Set<string>([profile?.apiKey, process.env.DEEPSEEK_API_KEY].filter(Boolean) as string[]);
  const safe = (text: string) => clean(redact(text, ...secrets));
  if (values.check) {
    const runtime = runtimeOptions(profile, catalogPath, values.model);
    const client = new CodexClient(binary, runtime.args, runtime.env);
    try {
      await client.initialize();
      console.log(`Codex app-server 握手成功（${profile ? 'DeepSeek' : 'Codex 配置'}；未验证模型推理）。`);
    } finally { await client.close(); }
    return;
  }
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行；环境检查可使用 --check');
  const ui = new AgentUI(cwd);
  let active: Backend | undefined;
  let candidate: Backend | undefined;
  let closing = false;
  let shutdownTask: Promise<void> | undefined;
  let commandBusy = false;
  let loginController: AbortController | undefined;
  let modelOverride = values.model;
  let historyCursor: string | null = null;
  let historyLoaded = false;
  let saves = Promise.resolve();
  let finish!: () => void;
  const finished = new Promise<void>((resolveDone) => { finish = resolveDone; });
  // Keep last-session pointers separate for each provider.
  const statePath = () => join(stateDir, createHash('sha256').update(`${cwd}\0${profile ? 'deepseek' : 'codex'}`).digest('hex') + '.json');
  const report = (error: unknown) => {
    const message = safe(error instanceof Error ? error.message : String(error));
    if (!closing) ui.notice(message, true);
  };
  const save = () => {
    const path = statePath(), threadId = active!.session.threadId;
    const provider = profile ? 'deepseek' : 'codex';
    saves = saves.catch(() => {}).then(async () => {
      await mkdir(stateDir, { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ cwd, threadId, provider }, null, 2), { mode: 0o600 });
      await rename(temp, path);
    });
    return saves;
  };
  const updateContext = () => {
    const session = active!.session;
    ui.setContext(session.threadId, `${profile ? 'DeepSeek · ' : ''}${session.displayModel}`, session.displayEffort, session.settingsPending);
  };
  const createBackend = (nextProfile?: DeepSeekProfile, model?: string) => {
    const backend = new Backend({ binary, cwd, profile: nextProfile, catalogPath, model,
      ask: (text, signal) => ui.ask(safe(text), signal), report });
    backend.on('diagnostic', (text) => { if (process.env.DEBUG) report(text); });
    backend.on('disconnect', (error) => {
      if (!closing && active === backend) { report(error); process.exitCode = 1; void shutdown(); }
    });
    backend.on('notification', (message: Message) => {
      if (closing || active !== backend) return;
      if (message.method === 'turn/completed') void save().catch(report);
      // Redact known credentials even if a backend diagnostic is returned as an item.
      ui.handleNotification(JSON.parse(redact(JSON.stringify(message), ...secrets)));
      if (message.method === 'turn/started' || message.method === 'turn/completed' || message.method === 'model/rerouted') updateContext();
    });
    return backend;
  };
  const shutdown = () => {
    if (shutdownTask) return shutdownTask;
    closing = true;
    loginController?.abort();
    shutdownTask = (async () => {
      ui.stop();
      try {
        if (active?.session.busy) await active.session.interrupt();
      } catch { /* Backend may already be disconnected. */ }
      finally {
        await Promise.all([active?.close(), candidate?.close()]);
        await saves.catch(() => {});
        finish();
      }
    })();
    return shutdownTask;
  };
  const interrupt = async () => {
    if (loginController) { loginController.abort(); ui.setBusy(false); return; }
    active?.approvals.clear();
    if (active?.session.busy) { ui.setBusy(true, '正在取消'); await active.session.interrupt(); }
    else ui.setBusy(false);
  };
  const onTerminate = () => { void shutdown(); };
  process.once('SIGTERM', onTerminate);

  // Prepare and validate a replacement first; a failed login leaves the old runtime usable.
  const switchProvider = async (nextProfile?: DeepSeekProfile) => {
    if (nextProfile) secrets.add(nextProfile.apiKey);
    candidate = createBackend(nextProfile);
    try {
      await candidate.connect();
      if (closing || loginController?.signal.aborted) throw new Error('已取消登录');
      if (nextProfile) await saveProfile(stateDir, nextProfile);
      else await removeProfile(stateDir);
      const old = active;
      active = candidate; candidate = undefined;
      profile = nextProfile; modelOverride = undefined;
      historyCursor = null; historyLoaded = true; ui.resetConversation();
      updateContext();
      await old?.close();
      ui.notice(nextProfile ? `DeepSeek 凭据已验证，已切换到 ${nextProfile.model} 的新会话。` : '本地 DeepSeek 凭据已移除，已切回 Codex 配置的新会话。');
    } finally { await candidate?.close(); candidate = undefined; }
  };
  const loadHistory = async (older = false) => {
    if (older && historyLoaded && !historyCursor) { ui.notice('已到达会话最早的消息。'); return; }
    const session = active!.session;
    ui.setBusy(true, '读取历史消息');
    const page = await session.history(older && historyCursor ? historyCursor : undefined);
    if (closing || active?.session !== session) return;
    historyCursor = page.nextCursor; historyLoaded = true;
    ui.loadHistory(JSON.parse(redact(JSON.stringify(page.turns), ...secrets)), older);
    if (!older) ui.notice(`已恢复最近 ${page.turns.length} 轮消息。${historyCursor ? '输入 /history 加载更早记录。' : ''}`);
  };
  const open = async (id?: string) => {
    ui.setBusy(true, id ? '恢复会话' : '创建会话');
    await active!.session.open(id);
    if (id) await save();
    historyCursor = null; historyLoaded = !id; ui.resetConversation();
    updateContext();
    if (id) await loadHistory().catch(report);
    ui.notice(`${id ? '已恢复会话' : '已创建会话'}：${active!.session.threadId}`);
  };
  const chooseSession = async () => {
    const session = active!.session;
    const selection = await ui.select({
      title: '继续工作 / 会话', subtitle: '当前项目 · 当前提供商 · 输入标题搜索',
      load: async (query, cursor, signal) => {
        signal.throwIfAborted();
        const page = await session.listThreads(query, cursor);
        signal.throwIfAborted();
        return { nextCursor: page.nextCursor, items: page.data.map((thread: ThreadInfo) => ({
          value: thread.id, label: safe(thread.name || thread.preview || '未命名会话').replace(/\s+/g, ' '),
          description: `${new Date(thread.updatedAt * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${thread.model ?? '模型未记录'} · ${thread.id.slice(0, 12)}`,
          current: thread.id === session.threadId,
        })) };
      },
    });
    if (selection && !closing && selection.value !== session.threadId) await open(selection.value);
  };
  const chooseModel = async (name?: string) => {
    const session = active!.session;
    if (!name) {
      ui.setBusy(true, '读取模型目录');
      const models = await session.models();
      if (closing) return;
      ui.setBusy(false);
      const selection = await ui.select({ title: '模型', subtitle: '保留当前会话 · 选择将从下一轮请求生效', items: models.map((model) => ({
        value: model.model, label: model.displayName || model.model,
        description: `${model.model} · ${model.description ?? ''}`, current: model.model === session.displayModel,
      })) });
      name = selection?.value;
    }
    if (!name || closing) return;
    await session.setModel(name); updateContext();
    ui.notice(`下一轮使用 ${session.displayModel}，思考强度 ${session.displayEffort ?? '后端默认'}。`);
  };
  const chooseEffort = async (effort?: string) => {
    const session = active!.session;
    if (!effort) {
      ui.setBusy(true, '读取模型能力');
      const model = (await session.models()).find((item) => item.model === session.displayModel);
      if (closing) return;
      const supported = model?.supportedReasoningEfforts ?? [];
      if (!supported.length) throw new Error('当前模型未声明可调整的思考强度');
      const descriptions: Record<string, string> = { minimal: '最少思考，快速完成简单请求', low: '轻量思考，优先响应速度', medium: '平衡响应速度与推理深度', high: '深入推理，适合复杂问题', xhigh: '更深入的推理', max: '最高推理深度', ultra: '以模型声明的最高能力运行' };
      ui.setBusy(false);
      const selection = await ui.select({ title: '思考强度', subtitle: `${session.displayModel} · 仅展示模型声明支持的选项`, items: supported.map((option) => ({
        value: option.reasoningEffort, label: option.reasoningEffort,
        description: descriptions[option.reasoningEffort] ?? option.description,
        current: option.reasoningEffort === (session.displayEffort ?? model?.defaultReasoningEffort),
      })) });
      effort = selection?.value;
    }
    if (!effort || closing) return;
    await session.setEffort(effort); updateContext();
    ui.notice(`思考强度已设为 ${effort}，下一轮生效。`);
  };
  ui.onExit = () => { void shutdown(); };
  ui.onInterrupt = () => { void interrupt().catch(report); };
  ui.onSubmit = (raw) => {
    void (async () => {
      const text = raw.trim();
      if (!text) return;
      if (text === '/exit') { await shutdown(); return; }
      if (text === '/cancel') { ui.clearEditor(); await interrupt(); return; }
      if (commandBusy || !active || active.session.busy) { ui.notice('任务执行中。按 Esc 取消；输入草稿已保留。'); return; }
      commandBusy = true;
      ui.clearEditor();
      try {
        if (text === '/login' || text === '/login deepseek') {
          loginController = new AbortController();
          ui.setBusy(true, '登录 DeepSeek');
          try {
            const next = await deepSeekLogin((prompt, signal, options) => ui.ask(prompt, signal, options), loginController.signal);
            loginController.signal.throwIfAborted();
            await switchProvider(next);
          } finally { loginController = undefined; }
        } else if (text === '/logout') {
          ui.setBusy(true, '切回 Codex 配置');
          await switchProvider();
        } else if (text === '/help') ui.notice(help);
        else if (text === '/status') ui.notice(`项目: ${cwd}\n会话: ${active.session.threadId}\n提供商: ${profile ? 'DeepSeek' : 'Codex 配置'}\n模型: ${active.session.displayModel}\n思考强度: ${active.session.displayEffort ?? '默认'}${active.session.settingsPending ? '（下轮生效）' : ''}\n二进制: ${binary}`);
        else if (text === '/new') await open();
        else if (text.startsWith('/resume ')) await open(text.slice(8).trim());
        else if (text === '/sessions' || text === '/resume') await chooseSession();
        else if (text === '/history') await loadHistory(true);
        else if (text === '/model') await chooseModel();
        else if (text.startsWith('/model ')) await chooseModel(text.slice(7).trim());
        else if (text === '/effort') await chooseEffort();
        else if (text.startsWith('/effort ')) await chooseEffort(text.slice(8).trim());
        else if (text === '/usage') ui.notice(ui.usageDetails());
        else if (text.startsWith('/')) ui.notice('未知命令，输入 /help 查看帮助');
        else { ui.user(text); ui.setBusy(true); await active.session.run(text); updateContext(); }
      } finally {
        commandBusy = false;
        if (!active?.session.busy) ui.setBusy(false);
      }
    })().catch((error) => { report(error); if (!active?.session.busy) ui.setBusy(false); });
  };
  try {
    ui.start(); ui.setBusy(true, '连接后端');
    let resumeId = values.resume;
    if (values.continue) {
      // Older versions saved only cwd; retain compatibility for Codex sessions.
      const legacy = join(stateDir, createHash('sha256').update(cwd).digest('hex') + '.json');
      let saved;
      try { saved = JSON.parse(await readFile(statePath(), 'utf8')); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        if (profile) throw new Error('当前项目没有保存的 DeepSeek 会话');
        saved = JSON.parse(await readFile(legacy, 'utf8').catch(() => { throw new Error('当前项目没有保存的会话'); }));
      }
      if (saved.cwd !== cwd || typeof saved.threadId !== 'string') throw new Error('会话文件无效');
      resumeId = saved.threadId;
    }
    candidate = createBackend(profile, modelOverride);
    await candidate.connect(resumeId);
    if (closing) return;
    active = candidate; candidate = undefined;
    if (resumeId) await save();
    historyLoaded = !resumeId; ui.resetConversation();
    updateContext();
    if (resumeId) await loadHistory().catch(report);
    ui.setBusy(false);
    ui.notice(`已${resumeId ? '恢复' : '创建'}会话：${active.session.threadId}。输入 /login 可登录 DeepSeek。`);
    await finished;
  } finally { await shutdown(); process.removeListener('SIGTERM', onTerminate); }
}

main().catch((error) => { process.stderr.write(clean(error.message) + '\n'); process.exitCode = 1; });
