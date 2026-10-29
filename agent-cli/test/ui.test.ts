import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { AgentUI, PromptDialog, SecretInput, UserMessage, clean } from '../src/ui.ts';
import { PickerDialog } from '../src/panels.ts';

class TestTerminal implements Terminal {
  columns = 90;
  rows = 30;
  kittyProtocolActive = false;
  output = '';
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus(_status: any) {}
}

test('user messages use a bounded frame with readable Chinese and multiple lines', () => {
  const message = new UserMessage();
  message.setText('第一行中文\n第二行内容很长，需要在窄屏幕上换行');
  for (const width of [4, 12, 24, 80]) {
    const lines = message.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width >= 6) {
      assert.match(clean(lines[0]), /╭/);
      assert.match(clean(lines.at(-1)!), /╰/);
    }
    assert.match(lines.map(clean).join(''), /第一行/);
  }
});

test('live and historical user messages display only their frames without a name label', (t) => {
  const { ui, screen } = setup(t);
  ui.resetConversation();
  ui.user('当前输入');
  ui.loadHistory([{ id: 'old', items: [{ id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: '历史输入' }] }] }], true);
  const text = screen();
  assert.match(text, /当前输入/);
  assert.match(text, /历史输入/);
  assert.doesNotMatch(text, /› 你/);
});

test('long tool output is summarized while full available output remains accessible', (t) => {
  const { ui, screen } = setup(t);
  const output = Array.from({ length: 80 }, (_, i) => `输出第 ${i} 行`).join('\n');
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'large-command', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: output,
  } } });
  assert.match(screen(), /点击展开/);
  assert.doesNotMatch(screen(), /输出第 79 行/);
  assert.equal(ui.toggleTool('thread-test:large-command'), true);
  assert.match(screen(), /输出第 79 行/);
  assert.equal(ui.toggleTool('thread-test:large-command'), true);
  assert.match(screen(), /点击展开/);
});

test('clicking a tool entry expands and collapses it in place, Ctrl+O also works', (t) => {
  const { ui, terminal, screen } = setup(t);
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'clickable', type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0,
    aggregatedOutput: 'one\ntwo\nthree\nfour\nfive',
  } } });
  const click = () => {
    const row = screen().split('\n').findIndex((line) => line.includes('命令 · completed')) + 1;
    assert.ok(row > 0);
    terminal.input(`\x1b[<0;5;${row}M`);
    terminal.input(`\x1b[<0;5;${row}m`);
  };
  assert.doesNotMatch(screen(), /five/);
  click();
  assert.match(screen(), /five/);
  click();
  assert.doesNotMatch(screen(), /five/);
  terminal.input('\x0f');
  assert.match(screen(), /five/);
});

function setup(t: any) {
  const terminal = new TestTerminal();
  const ui = new AgentUI('/项目/codex', terminal);
  ui.setContext('thread-test', 'configured-model');
  ui.start();
  t.after(() => ui.stop());
  const screen = () => {
    ui.tui.renderNow(true);
    return ui.tui.getScreenLines().map(clean).join('\n');
  };
  return { terminal, ui, screen };
}

test('fullscreen layout shows effective model, Markdown, tool output and bounded lines', (t) => {
  const { ui, terminal, screen } = setup(t);
  ui.handleNotification({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: '### 你好\n\n**中文**与 `代码`' } });
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'a', type: 'agentMessage', text: '### 权威最终消息\n\n流式内容被最终消息替换。',
  } } });
  ui.handleNotification({ method: 'item/completed', params: { item: {
    id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: '测试通过',
  } } });
  const text = screen();
  assert.match(text, /configured-model/);
  assert.match(text, /项目\/codex/);
  assert.match(text, /Alt\+Enter/);
  assert.match(text, /权威最终消息/);
  assert.match(text, /✦ Dicode/);
  assert.doesNotMatch(text, /✦ Codex/);
  assert.match(text, /测试通过/);
  assert.doesNotMatch(text, /流式内容被最终消息替换。.*流式内容被最终消息替换。/);
  for (const line of ui.tui.getScreenLines()) assert.ok(visibleWidth(line) <= terminal.columns);
});

test('resizing with long CJK text keeps editor and status within viewport', (t) => {
  const { ui, terminal, screen } = setup(t);
  ui.notice('中文长文本'.repeat(500));
  ui.editor.setText('输入草稿');
  for (const [width, height] of [[40, 18], [24, 10], [120, 40]]) {
    terminal.columns = width; terminal.rows = height; terminal.resize();
    const text = screen();
    assert.match(text, /输入草稿/);
    assert.equal(ui.tui.getScreenLines().length, height);
    for (const line of ui.tui.getScreenLines()) assert.ok(visibleWidth(line) <= width);
  }
});

test('approval captures focus, Escape declines, abort restores unsent editor draft', async (t) => {
  const { ui, screen } = setup(t);
  ui.editor.setText('尚未发送的草稿');
  const controller = new AbortController();
  const result = ui.ask('允许执行 npm test？[y/N]', controller.signal);
  assert.match(screen(), /需要你的确认/);
  ui.tui.getFocusedComponent()!.handleInput!('\x1b');
  assert.equal(await result, '');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.equal(ui.editor.getText(), '尚未发送的草稿');
  const next = new AbortController();
  const rejected = assert.rejects(ui.ask('权限请求', next.signal), /已取消/);
  next.abort();
  await rejected;
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
});

test('Ctrl+C cancels busy work and exits when idle', (t) => {
  const { ui, terminal } = setup(t);
  let interrupted = 0, exited = 0;
  ui.onInterrupt = () => { interrupted++; };
  ui.onExit = () => { exited++; };
  ui.setBusy(true);
  terminal.input('\x03');
  assert.equal(interrupted, 1);
  assert.equal(exited, 0);
  ui.setBusy(false);
  terminal.input('\x03');
  assert.equal(exited, 1);
});

test('long approval details scroll without hiding input; terminal escapes are stripped', () => {
  const dialog = new PromptDialog('开头\n' + '权限详情\n'.repeat(100) + '末尾\x1b[2J', () => 12);
  dialog.input.setValue('yes');
  const before = dialog.render(28);
  assert.ok(before.length <= 12);
  assert.match(before.map(clean).join('\n'), /开头/);
  for (let i = 0; i < 100; i++) dialog.handleInput('\x1b[6~');
  const after = dialog.render(28);
  assert.match(after.map(clean).join('\n'), /末尾/);
  assert.match(after.map(clean).join('\n'), /yes/);
  for (const line of after) assert.ok(visibleWidth(line) <= 28);
  assert.equal(clean('安全\x1b[2J\x1b]0;危险标题\x07文本'), '安全文本');
});

test('login input never renders the API key and Escape cancels without submitting', async (t) => {
  const secret = new SecretInput();
  secret.setValue('sk-hidden-test-key');
  assert.equal(secret.getValue(), 'sk-hidden-test-key');
  assert.ok(!secret.render(80).join('').includes('sk-hidden-test-key'));
  assert.match(clean(secret.render(80).join('')), /•/);
  const { ui, screen } = setup(t);
  const controller = new AbortController();
  const failed = assert.rejects(ui.ask('输入 API Key', controller.signal, { secret: true, title: '登录 DeepSeek', cancelReject: true }), /已取消/);
  const dialog = ui.tui.getFocusedComponent() as PromptDialog;
  dialog.input.setValue('sk-hidden-test-key');
  assert.match(screen(), /登录 DeepSeek/);
  assert.ok(!screen().includes('sk-hidden-test-key'));
  dialog.handleInput('\x1b');
  await failed;
});

test('model picker searches, marks current choice and restores editor draft on selection', async (t) => {
  const { ui, screen } = setup(t);
  ui.editor.setText('尚未提交的工作草稿');
  const selected = ui.select({ title: '模型', subtitle: '下轮请求生效', items: [
    { value: 'balanced', label: 'Balanced', description: '日常任务', current: true },
    { value: 'deep', label: 'Deep', description: '复杂问题' },
  ] });
  assert.match(screen(), /当前/);
  const panel = ui.tui.getFocusedComponent() as PickerDialog;
  for (const char of 'deep') panel.handleInput(char);
  assert.match(screen(), /Deep/);
  assert.doesNotMatch(screen(), /Balanced/);
  panel.handleInput('\r');
  assert.equal((await selected)?.value, 'deep');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.equal(ui.editor.getText(), '尚未提交的工作草稿');
});

test('selectors live in the bottom composer, keep conversation visible and never create an overlay', async (t) => {
  const { ui, terminal, screen } = setup(t);
  ui.notice('最近的对话仍然可见');
  const before = screen().split('\n');
  const result = ui.select({ title: '模型', items: [
    { value: 'balanced', label: 'Balanced', description: '日常任务', current: true },
    { value: 'deep', label: 'Deep', description: '复杂问题' },
  ] });
  const lines = screen().split('\n');
  assert.equal(ui.tui.hasOverlay(), false);
  assert.equal(lines[0], before[0]);
  assert.match(lines.join('\n'), /最近的对话仍然可见/);
  assert.ok(lines.findIndex((line) => line.includes('─ 模型')) >= terminal.rows - 12);
  assert.match(lines.at(-1)!, /输入搜索/);
  assert.ok(!lines.some((line) => line.includes('╭') || line.includes('╰')));
  ui.tui.getFocusedComponent()!.handleInput!('\x1b');
  assert.equal(await result, undefined);
});

test('Ctrl+C closes inline selection, restores the draft and does not exit', async (t) => {
  const { ui, terminal } = setup(t);
  let exited = false;
  ui.onExit = () => { exited = true; };
  ui.editor.setText('继续编辑的草稿');
  const result = ui.select({ title: '会话', items: [{ value: 'saved', label: '已有会话' }] });
  terminal.input('\x03');
  assert.equal(await result, undefined);
  assert.equal(exited, false);
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.equal(ui.editor.getText(), '继续编辑的草稿');
});

test('mouse click confirms an effort option and returns focus to the editor', async (t) => {
  const { ui, screen } = setup(t);
  ui.editor.setText('保留的草稿');
  const selected = ui.select({ title: '思考强度', items: [
    { value: 'low', label: 'low' }, { value: 'high', label: 'high', current: true }, { value: 'max', label: 'max' },
  ] });
  screen();
  const panel = ui.tui.getFocusedComponent() as PickerDialog;
  const mouse = { button: 'left', x: 4, y: 2, screenX: 4, screenY: 20, width: 90, height: 6, shift: false, alt: false, ctrl: false } as const;
  assert.equal(panel.handleMouse({ ...mouse, type: 'press' })?.handled, true);
  panel.handleMouse({ ...mouse, type: 'click' });
  assert.equal((await selected)?.value, 'low');
  assert.equal(ui.tui.getFocusedComponent(), ui.editor);
  assert.equal(ui.editor.getText(), '保留的草稿');
});

test('mouse selection stays on the pressed item when list scrolling shifts rendered rows', () => {
  const panel = new PickerDialog({ title: '模型', items: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `Model ${i}` })) }, () => 8, () => {});
  let selected: string | undefined;
  panel.onSelect = (item) => { selected = item.value; };
  panel.render(90);
  const mouse = { button: 'left', x: 4, y: 6, screenX: 4, screenY: 20, width: 90, height: 8, shift: false, alt: false, ctrl: false } as const;
  panel.handleMouse({ ...mouse, type: 'press' });
  panel.render(90);
  panel.handleMouse({ ...mouse, type: 'click' });
  assert.equal(selected, '4');
  panel.dispose();
});

test('search dialog remains bounded on narrow and short terminals; Escape cancels', async (t) => {
  const { ui, terminal } = setup(t);
  const result = ui.select({ title: '会话', items: Array.from({ length: 40 }, (_, i) => ({ value: String(i), label: `很长的中文标题\n${i} `.repeat(10), description: '说明\n'.repeat(50) })) });
  for (const [width, height] of [[24, 10], [40, 18], [120, 40]]) {
    terminal.columns = width; terminal.rows = height; terminal.resize(); ui.tui.renderNow(true);
    for (const line of ui.tui.getScreenLines()) assert.ok(visibleWidth(line) <= width);
    const dialog = ui.tui.getFocusedComponent() as PickerDialog;
    const lines = dialog.render(Math.floor(width * .92));
    assert.ok(lines.length <= height - 2);
    for (const line of lines) assert.ok(!line.includes('\n'));
  }
  ui.tui.getFocusedComponent()!.handleInput!('\x1b');
  assert.equal(await result, undefined);
});

test('remote search ignores stale responses, loads more pages and disposes pending work', async () => {
  const requests: any[] = [];
  const panel = new PickerDialog({ title: '会话', load: (query, cursor, signal) => new Promise((resolve) => requests.push({ query, cursor, signal, resolve })) }, () => 24, () => {});
  panel.start();
  panel.handleInput('b');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ items: [{ value: 'b', label: '当前搜索结果' }], nextCursor: 'page2' });
  await new Promise((resolve) => setImmediate(resolve));
  requests[0].resolve({ items: [{ value: 'old', label: '过期结果' }] });
  await new Promise((resolve) => setImmediate(resolve));
  let rendered = panel.render(80).map(clean).join('\n');
  assert.match(rendered, /当前搜索结果/);
  assert.doesNotMatch(rendered, /过期结果/);
  panel.handleInput('\x1b[B'); panel.handleInput('\r');
  assert.equal(requests[2].cursor, 'page2');
  requests[2].resolve({ items: [{ value: 'b2', label: '第二页结果' }], nextCursor: null });
  await new Promise((resolve) => setImmediate(resolve));
  rendered = panel.render(80).map(clean).join('\n');
  assert.match(rendered, /第二页结果/);
  panel.dispose();
  assert.equal(requests[2].signal.aborted, true);
});

test('history prepends older items in order, deduplicates pages and resets usage between conversations', (t) => {
  const { ui, screen } = setup(t);
  ui.notice('旧会话不能残留的内容');
  ui.resetConversation(); ui.setContext('saved', 'model', 'high', true);
  const recent = [{ id: 'recent', items: [
    { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: '最近的用户消息' }] },
    { id: 'agent-2', type: 'agentMessage', text: '最近的回复' },
  ] }];
  ui.loadHistory(recent);
  const old = [{ id: 'older', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '更早的用户消息' }] }] }];
  ui.loadHistory(old, true); ui.loadHistory(old, true);
  const text = screen();
  assert.doesNotMatch(text, /旧会话不能残留/);
  assert.match(text, /下轮生效/);
  assert.ok(text.indexOf('更早的用户消息') < text.indexOf('最近的用户消息'));
  assert.match(text, /✦ Dicode/);
  assert.equal(text.split('更早的用户消息').length - 1, 1);
  const breakdown = { totalTokens: 2500, inputTokens: 2000, outputTokens: 500, cachedInputTokens: 1000, reasoningOutputTokens: 100 };
  ui.setUsage({ total: { ...breakdown, totalTokens: 100000 }, last: breakdown, modelContextWindow: 10000 });
  assert.match(screen(), /25%/);
  assert.match(screen(), /累计 100k/);
  ui.resetConversation();
  assert.match(screen(), /等待后端用量/);
});
