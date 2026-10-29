import {
  Box, CombinedAutocompleteProvider, Container, Editor, Input, Markdown, MouseRegion,
  ProcessTerminal, ScrollView, Text, TruncatedText, TuiAltScreen, VStack,
  matchesKey, truncateToWidth, visibleWidth,
  type Component, type Focusable, type MarkdownTheme, type Terminal,
} from '@earendil-works/pi-tui';
import type { Message } from './client.ts';
import { clean, color, cyan, dim, green, amber, bold, red } from './theme.ts';
import { PickerDialog, type PickerItem, type PickerOptions } from './panels.ts';
import { usageSummary } from './usage.ts';
import type { HistoryTurn, TokenUsage } from './types.ts';

export { clean } from './theme.ts';
const markdownTheme: MarkdownTheme = {
  heading: cyan, link: cyan, linkUrl: dim, code: amber, codeBlock: (s) => s,
  codeBlockBorder: dim, quote: dim, quoteBorder: cyan, hr: dim,
  listBullet: cyan, bold, italic: color('3'), strikethrough: color('9'), underline: color('4'),
};
const selectTheme = {
  selectedPrefix: cyan, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim,
};

/** TruncatedText is immutable in pi-tui; keep a small mutable wrapper for status. */
class MutableLine implements Component {
  private text: string;
  private paddingX: number;
  private paddingY: number;
  constructor(text: string, paddingX = 1, paddingY = 0) {
    this.text = text; this.paddingX = paddingX; this.paddingY = paddingY;
  }
  setText(text: string) { this.text = text; }
  invalidate() {}
  render(width: number) { return new TruncatedText(this.text, this.paddingX, this.paddingY).render(width); }
}
class SplitLine implements Component {
  left = '';
  right = '';
  invalidate() {}
  render(width: number) {
    const available = Math.max(1, width - 2);
    const right = truncateToWidth(this.right, Math.max(0, available - Math.min(16, Math.floor(available / 2))), '…');
    const left = truncateToWidth(this.left, Math.max(0, available - visibleWidth(right) - 2), '…');
    return [truncateToWidth(' ' + left + ' '.repeat(Math.max(1, available - visibleWidth(left) - visibleWidth(right))) + right, width)];
  }
}
/** Wrap user messages in a quiet frame, including wide and multi-line text. */
export class UserMessage implements Component {
  private body = new Text('', 0, 0);
  setText(text: string) { this.body.setText(text); }
  invalidate() { this.body.invalidate(); }
  render(width: number) {
    if (width < 7) return this.body.render(Math.max(1, width)).map((line) => truncateToWidth(line, width));
    const inner = width - 6;
    const border = cyan('› ╭' + '─'.repeat(width - 4) + '╮');
    const bottom = cyan('  ╰' + '─'.repeat(width - 4) + '╯');
    const lines = this.body.render(inner).map((line) => {
      const text = truncateToWidth(line, inner);
      return cyan('  │ ') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + cyan(' │');
    });
    return [border, ...lines, bottom];
  }
}
const commands = [
  { name: 'login', description: '登录 DeepSeek', argumentHint: 'deepseek' },
  { name: 'logout', description: '移除本地 DeepSeek 凭据' },
  { name: 'help', description: '查看帮助' }, { name: 'new', description: '新建会话' },
  { name: 'resume', description: '恢复会话', argumentHint: 'thread-id' },
  { name: 'sessions', description: '搜索并恢复会话' },
  { name: 'history', description: '加载更早的消息' },
  { name: 'model', description: '选择模型' },
  { name: 'effort', description: '调整思考强度' }, { name: 'usage', description: 'Token 用量详情' },
  { name: 'status', description: '当前会话信息' },
  { name: 'cancel', description: '取消当前任务' }, { name: 'exit', description: '退出' },
];

/** A bounded, scrollable prompt: long permission details cannot push input offscreen. */
export class SecretInput extends Input {
  render(width: number) {
    const mask = new Input();
    mask.focused = this.focused;
    mask.setValue('•'.repeat(Array.from(this.getValue()).length));
    return mask.render(width);
  }
}

export type PromptOptions = { secret?: boolean; title?: string; cancelReject?: boolean };

export class PromptDialog implements Component, Focusable {
  readonly input: Input;
  private title: string;
  private content: Text;
  private offset = 0;
  private height: () => number;
  private _focused = false;
  onCancel?: () => void;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(text: string, height: () => number, options: PromptOptions = {}) {
    this.input = options.secret ? new SecretInput() : new Input();
    this.title = clean(options.title ?? '需要你的确认');
    this.content = new Text(clean(text), 0, 0);
    this.height = height;
  }
  invalidate() { this.content.invalidate(); this.input.invalidate(); }
  handleInput(data: string) {
    if (matchesKey(data, 'escape')) { this.onCancel?.(); return; }
    if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - 4);
    else if (matchesKey(data, 'pageDown')) this.offset += 4;
    else this.input.handleInput(data);
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines = this.content.render(inner);
    const available = Math.max(1, this.height() - 5);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - available));
    const frame = (text: string) => truncateToWidth(
      amber('│ ') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + amber(' │'), width,
    );
    return [
      truncateToWidth(amber(`╭─ ${this.title} ` + '─'.repeat(Math.max(0, width - visibleWidth(this.title) - 5)) + '╮'), width),
      ...lines.slice(this.offset, this.offset + available).map(frame),
      frame(dim(lines.length > available ? 'PgUp/PgDn 查看详情 · Esc 拒绝' : 'Enter 提交 · Esc 拒绝')),
      frame(this.input.render(inner)[0] ?? ''),
      truncateToWidth(amber('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'), width),
    ];
  }
}

type Entry = {
  container: Container;
  node: Component;
  title: MutableLine;
  body: Text | Markdown | UserMessage;
  text: string;
  kind: string;
  name: string;
  expanded: boolean;
};

export class AgentUI {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private terminal: Terminal;
  private transcript = new Container();
  private welcome = new Box(2, 1);
  private scroll: ScrollView;
  private header = new SplitLine();
  private context = new SplitLine();
  private status = new SplitLine();
  private hint = new MutableLine('', 1, 0);
  private entries = new Map<string, Entry>();
  private sequence = 0;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private busy = false;
  private startedAt = 0;
  private cwd: string;
  private model = '读取配置中';
  private threadId = '';
  private state = '就绪';
  private cancelPrompt?: () => void;
  private cancelPanel?: () => void;
  private selectionPanel?: PickerDialog;
  private effort: string | undefined;
  private pendingSettings = false;
  private usage: TokenUsage | undefined;
  private hydrating = false;
  onSubmit?: (text: string) => void;
  onInterrupt?: () => void;
  onExit?: () => void;

  constructor(cwd: string, terminal: Terminal = new ProcessTerminal()) {
    this.cwd = cwd;
    this.terminal = terminal;
    this.tui = new TuiAltScreen(terminal, true);
    this.tui.setCopyOnSelect(false);
    this.scroll = new ScrollView(this.transcript, {
      follow: 'end', primary: true, scrollbar: 'auto', scrollbarThumbStyle: cyan,
    });
    this.editor = new Editor(this.tui, { borderColor: cyan, selectList: selectTheme }, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, cwd));
    this.editor.onSubmit = (text) => this.onSubmit?.(text);
    this.updateLayout();
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+o') && !this.cancelPanel && !this.cancelPrompt) {
        this.toggleTools();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+c')) {
        if (this.cancelPanel) this.cancelPanel();
        else if (this.busy || this.cancelPrompt) this.onInterrupt?.();
        else this.onExit?.();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+d') && !this.editor.getText() && !this.cancelPrompt && !this.cancelPanel) {
        this.onExit?.(); return { consume: true };
      }
      if (matchesKey(data, 'escape') && this.busy && !this.cancelPrompt && !this.cancelPanel) {
        this.onInterrupt?.(); return { consume: true };
      }
      return undefined;
    });
    const welcome = this.welcome;
    welcome.addChild(new Text(cyan(bold('DICODE')) + '  /  你的项目工作台', 0, 0));
    welcome.addChild(new Text('\n从一个清晰的任务开始。\n描述目标、附上约束，让 Agent 调查、执行并验证。\n\n/sessions  继续之前的工作\n/model     选择模型与能力\n/effort    调整思考强度', 0, 0));
    this.transcript.addChild(welcome);
    this.refresh();
  }

  private updateLayout() {
    this.tui.setLayoutRoot(new VStack([
      { component: this.header, basis: 1, shrink: 0 },
      { component: this.context, basis: 1, shrink: 0, visible: ({ height }) => height >= 12 },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: this.selectionPanel ?? this.editor, basis: 'auto', minSize: 3, maxSize: this.selectionPanel ? 12 : 8, shrink: 1 },
      { component: this.status, basis: 1, shrink: 0 },
      { component: this.hint, basis: 1, shrink: 0, visible: ({ height }) => height >= 10 },
    ]));
  }

  private refresh() {
    this.header.left = cyan(bold('DICODE'));
    this.header.right = bold(this.model) + dim(` · ${this.effort ?? '默认强度'}`) + (this.pendingSettings ? amber(' · 下轮生效') : '');
    this.context.left = dim(this.cwd);
    this.context.right = dim(this.threadId ? this.threadId.slice(0, 18) : '连接后端中');
    const spinner = ['◐', '◓', '◑', '◒'][this.frame % 4];
    const seconds = this.busy ? ` · ${Math.floor((Date.now() - this.startedAt) / 1000)}s` : '';
    this.status.left = this.cancelPrompt ? amber('● 等待确认') : this.busy ? cyan(`${spinner} ${this.state}${seconds}`) : green(`● ${this.state}`);
    const usage = usageSummary(this.usage);
    const used = Math.round((usage.percent ?? 0) / 10);
    const bar = this.usage ? dim('[') + (usage.percent !== null && usage.percent >= 85 ? amber : cyan)('━'.repeat(used)) + dim('─'.repeat(10 - used) + '] ') : '';
    this.status.right = bar + dim(usage.compact);
    this.hint.setText(dim(this.selectionPanel ? '输入搜索 · ↑↓ 选择 · Enter 确认 · Esc 返回' : this.busy
      ? 'Esc 取消任务 · Ctrl+O 工具详情'
      : 'Enter 发送 · Alt+Enter 换行 · Ctrl+O 工具详情'));
    this.tui.requestRender();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.tui.start();
    this.timer = setInterval(() => { if (this.busy) { this.frame++; this.refresh(); } }, 120);
  }
  stop() {
    this.cancelPrompt?.();
    this.cancelPanel?.();
    clearInterval(this.timer);
    if (this.started) this.tui.stop();
    this.started = false;
  }
  setContext(threadId: string, model: string, effort?: string, pending = false) {
    this.threadId = threadId; this.model = clean(model); this.effort = effort; this.pendingSettings = pending; this.refresh();
  }
  resetConversation() {
    this.transcript.clear(); this.entries.clear(); this.usage = undefined;
    this.transcript.addChild(this.welcome);
    this.tui.resetTextSelection(); this.scroll.scrollToEnd(); this.refresh();
  }
  setUsage(usage?: TokenUsage) { this.usage = usage; this.refresh(); }
  usageDetails() { return usageSummary(this.usage).detail; }
  loadHistory(turns: HistoryTurn[], prepend = false) {
    if (turns.some((turn) => turn.items.length)) this.transcript.removeChild(this.welcome);
    const existing = [...this.entries.keys()];
    const oldKeys = new Set(existing);
    this.hydrating = true;
    try {
      for (const turn of turns) for (const item of turn.items) {
        if (item.type === 'userMessage') {
          const text = item.content.map((part: any) => part.type === 'text' ? part.text : part.type === 'localImage' ? `[图片: ${part.path}]` : `[${part.type}]`).join('\n');
          this.entry(`${this.threadId}:${item.id}`, '你', text, 'user');
        } else this.handleNotification({ method: 'item/completed', params: { threadId: this.threadId, turnId: turn.id, item } });
      }
    } finally { this.hydrating = false; }
    if (prepend) {
      const added = [...this.entries.keys()].filter((key) => !oldKeys.has(key));
      const order = [...added, ...existing];
      this.entries = new Map(order.map((key) => [key, this.entries.get(key)!]));
      this.transcript.clear();
      for (const entry of this.entries.values()) this.transcript.addChild(entry.node);
      this.scroll.scrollToStart();
    } else this.scroll.scrollToEnd();
    this.tui.requestRender();
  }
  setBusy(busy: boolean, state = busy ? 'Dicode 正在工作' : '就绪') {
    if (busy && !this.busy) this.startedAt = Date.now();
    this.busy = busy; this.state = state; this.refresh();
  }
  clearEditor() { this.editor.setText(''); this.tui.requestRender(); }
  user(text: string) {
    this.editor.addToHistory(text);
    this.entry(`user-${++this.sequence}`, '你', text, 'user');
    this.scroll.scrollToEnd();
  }
  notice(text: string, error = false) {
    this.entry(`notice-${++this.sequence}`, error ? '错误' : '系统', text, error ? 'error' : 'system');
  }
  private entry(id: string, title: string, text: string, kind = 'system') {
    let entry = this.entries.get(id);
    if (!entry) {
      const container = new Container();
      const label = new MutableLine('', 1, 1);
      const body = kind === 'agent' ? new Markdown('', 2, 0, markdownTheme) : kind === 'user' ? new UserMessage() : new Text('', 2, 0);
      if (kind !== 'user') container.addChild(label);
      container.addChild(body);
      const node = new MouseRegion(container, (event) => {
        const current = this.entries.get(id);
        if (!current || !['command', 'diff', 'pending-diff', 'tool'].includes(current.kind) || event.button !== 'left') return undefined;
        if (event.type === 'press') return { handled: true };
        if (event.type === 'click') { this.toggleTool(id); return { handled: true, render: true }; }
        return undefined;
      });
      entry = { container, node, title: label, body, text: '', kind, name: title, expanded: kind === 'pending-diff' };
      this.entries.set(id, entry);
      this.transcript.addChild(node);
      if (!this.hydrating && this.entries.size > 200) {
        const [oldest, old] = this.entries.entries().next().value!;
        this.transcript.removeChild(old.node); this.entries.delete(oldest);
      }
    }
    entry.text = clean(text);
    if (entry.kind === 'pending-diff' && kind === 'diff') entry.expanded = false;
    entry.kind = kind;
    entry.name = clean(title);
    const marker = kind === 'agent' ? '✦ ' : kind === 'user' ? '› ' : '· ';
    const isTool = ['command', 'diff', 'pending-diff', 'tool'].includes(kind);
    entry.title.setText((kind === 'agent' ? cyan : kind === 'user' ? bold : kind === 'error' ? red : dim)(marker + clean(title) + (isTool ? (entry.expanded ? '  ▾ 点击收起' : '  ▸ 点击展开') : '')));
    let displayed = isTool && entry.expanded ? entry.text : entry.text.length > 20_000 ? '[前文已截断，仅显示末尾]\n' + entry.text.slice(-20_000) : entry.text;
    if ((kind === 'command' || kind === 'diff' || kind === 'tool') && !entry.expanded) {
      const lines = entry.text.split('\n');
      const nonempty = lines.filter((line) => line.trim());
      const preview = kind === 'command' && /failed|declined|exit [1-9]/i.test(title)
        ? [lines[0], ...nonempty.slice(-3).filter((line) => line !== lines[0])]
        : nonempty.slice(0, 3);
      displayed = preview.map((line) => line.length > 100 ? line.slice(0, 100) + '…' : line).join('\n');
      if (nonempty.length > preview.length || preview.some((line) => line.length > 100)) displayed += `\n… 共 ${nonempty.length} 行`;
    }
    if (kind === 'diff' || kind === 'pending-diff') {
      entry.body.setText(displayed.split('\n').map((line) => line.startsWith('+') ? green(line) : line.startsWith('-') ? red(line) : line).join('\n'));
    } else entry.body.setText(displayed);
    this.tui.requestRender();
    return entry;
  }

  toggleTool(id: string) {
    const entry = this.entries.get(id);
    if (!entry || !['command', 'diff', 'pending-diff', 'tool'].includes(entry.kind)) return false;
    entry.expanded = !entry.expanded;
    this.entry(id, entry.name, entry.text, entry.kind);
    return true;
  }
  private toggleTools() {
    const tools = [...this.entries.entries()].filter(([, entry]) => ['command', 'diff', 'pending-diff', 'tool'].includes(entry.kind));
    const expand = tools.some(([, entry]) => !entry.expanded);
    for (const [id, entry] of tools) {
      entry.expanded = expand;
      this.entry(id, entry.name, entry.text, entry.kind);
    }
  }

  handleNotification(message: Message) {
    const p = message.params ?? {};
    const key = (id: string) => `${p.threadId ?? this.threadId}:${id}`;
    switch (message.method) {
      case 'thread/tokenUsage/updated': this.setUsage(p.tokenUsage); break;
      case 'item/agentMessage/delta': {
        const id = key(p.itemId);
        this.entry(id, 'Dicode', (this.entries.get(id)?.text ?? '') + p.delta, 'agent');
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const id = key(p.itemId), entry = this.entries.get(id);
        this.entry(id, '命令执行中', (entry?.text ?? '') + p.delta, 'command');
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item, id = key(item.id);
        const completed = message.method === 'item/completed';
        if (item.type === 'agentMessage' && completed) this.entry(id, 'Dicode', item.text, 'agent');
        if (item.type === 'commandExecution') {
          const previous = this.entries.get(id);
          const text = completed && item.aggregatedOutput != null
            ? `$ ${item.command}\n${item.aggregatedOutput}` : previous?.text ?? `$ ${item.command}\n`;
          this.entry(id, completed ? `命令 · ${item.status} · exit ${item.exitCode ?? '—'}` : '命令执行中', text, 'command');
        }
        if (item.type === 'fileChange') {
          const text = item.changes.map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n');
          this.entry(id, completed ? `文件变更 · ${item.status}` : '拟修改文件', text, completed ? 'diff' : 'pending-diff');
        }
        if (item.type === 'mcpToolCall') this.entry(id, `工具 · ${item.server}/${item.tool}`, completed ? JSON.stringify(item.result ?? item.error ?? item.status, null, 2) : '执行中…', 'tool');
        if (item.type === 'contextCompaction') this.entry(id, '上下文', completed ? '上下文已压缩' : '正在压缩上下文…');
        break;
      }
      case 'turn/plan/updated':
        this.entry(key(`plan-${p.turnId}`), '执行计划', (p.plan ?? []).map((s: any) => `${s.status === 'completed' ? '✓' : '○'} ${s.step}`).join('\n'));
        break;
      case 'error': this.notice(p.error?.message ?? 'Dicode 发生错误', true); break;
      case 'turn/completed':
        this.setBusy(false, p.turn.status === 'completed' ? '已完成' : p.turn.status === 'interrupted' ? '已取消' : '任务失败');
        if (p.turn.error) this.notice(p.turn.error.message, true);
        break;
    }
  }

  select(options: PickerOptions): Promise<PickerItem | undefined> {
    this.cancelPanel?.();
    return new Promise((resolveSelection) => {
      const panel = new PickerDialog(options, () => Math.max(4, Math.min(12, Math.floor(this.terminal.rows * .4))), () => this.tui.requestRender());
      let finished = false;
      const finish = (item?: PickerItem) => {
        if (finished) return;
        finished = true; panel.dispose(); this.cancelPanel = undefined; this.selectionPanel = undefined;
        this.updateLayout(); this.tui.setFocus(this.editor); this.refresh(); resolveSelection(item);
      };
      this.cancelPanel = () => finish();
      panel.onSelect = (item) => finish(item);
      panel.onCancel = () => finish();
      this.selectionPanel = panel;
      this.updateLayout(); this.tui.setFocus(panel); this.refresh();
      panel.start();
    });
  }

  ask(text: string, signal: AbortSignal, options: PromptOptions = {}): Promise<string> {
    if (signal.aborted) return Promise.reject(new Error('请求已取消'));
    return new Promise((resolveAnswer, reject) => {
      const dialog = new PromptDialog(text, () => Math.max(5, this.terminal.rows - 4), options);
      const overlay = this.tui.showOverlay(dialog, { width: '90%', maxHeight: '95%', margin: 1 });
      const finish = (answer?: string) => {
        signal.removeEventListener('abort', abort);
        overlay.hide(); this.cancelPrompt = undefined; this.refresh();
        if (answer === undefined) reject(new Error('请求已取消'));
        else resolveAnswer(answer);
      };
      const abort = () => finish();
      this.cancelPrompt = abort;
      dialog.input.onSubmit = (answer) => finish(answer);
      dialog.onCancel = () => finish(options.cancelReject ? undefined : '');
      signal.addEventListener('abort', abort, { once: true });
      this.refresh();
    });
  }
}
