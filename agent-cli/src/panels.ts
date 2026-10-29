import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { amber, bold, clean, cyan, dim } from './theme.ts';
const inline = (value: unknown) => clean(value).replace(/\s+/g, ' ').trim();

export type PickerItem = { value: string; label: string; description?: string; detail?: string; current?: boolean };
export type PickerPage = { items: PickerItem[]; nextCursor?: string | null };
export type PickerLoader = (query: string, cursor: string | undefined, signal: AbortSignal) => Promise<PickerPage>;
export type PickerOptions = { title: string; subtitle?: string; items?: PickerItem[]; load?: PickerLoader };

/** Compact selection surface mounted in the composer, not over the transcript. */
export class PickerDialog implements Component, Focusable {
  readonly search = new Input({ prompt: '⌕ ', placeholder: '搜索名称、描述…', placeholderStyle: dim });
  private options: PickerOptions;
  private height: () => number;
  private items: PickerItem[];
  private selected = 0;
  private query = '';
  private loading = false;
  private error = '';
  private nextCursor: string | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private version = 0;
  private disposed = false;
  private pageSize = 4;
  private renderedRows: PickerItem[] = [];
  private pressedValue: string | undefined;
  private _focused = false;
  onSelect?: (item: PickerItem) => void;
  onCancel?: () => void;
  private redraw: () => void;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.search.focused = value; }

  constructor(options: PickerOptions, height: () => number, redraw: () => void) {
    this.options = options; this.height = height; this.redraw = redraw;
    this.items = options.items ?? [];
    this.selected = Math.max(0, this.items.findIndex((item) => item.current));
  }
  start() { if (this.options.load) void this.load(); }
  invalidate() { this.search.invalidate(); }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.controller?.abort(); this.version++; }
  private visibleItems() {
    if (this.options.load) return this.items;
    const words = this.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((item) => words.every((word) =>
      `${item.label} ${item.description ?? ''} ${item.detail ?? ''} ${item.value}`.toLocaleLowerCase().includes(word)));
  }
  private async load(cursor?: string) {
    if (!this.options.load || this.disposed) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const version = ++this.version;
    this.loading = true; this.error = ''; this.redraw();
    try {
      const page = await this.options.load(this.query, cursor, controller.signal);
      if (this.disposed || version !== this.version || controller.signal.aborted) return;
      const items = cursor ? [...this.items, ...page.items] : page.items;
      this.items = [...new Map(items.map((item) => [item.value, item])).values()];
      this.nextCursor = page.nextCursor ?? undefined;
      this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    } catch (error) {
      if (version === this.version && !controller.signal.aborted) this.error = clean((error as Error).message);
    } finally {
      if (version === this.version && !this.disposed) { this.loading = false; this.redraw(); }
    }
  }
  handleInput(data: string) {
    if (matchesKey(data, 'escape')) { this.onCancel?.(); return; }
    const items = this.visibleItems();
    const count = items.length + (this.nextCursor ? 1 : 0);
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if (matchesKey(data, 'pageUp')) this.selected = Math.max(0, this.selected - this.pageSize);
    else if (matchesKey(data, 'pageDown')) this.selected = Math.min(Math.max(0, count - 1), this.selected + this.pageSize);
    else if (matchesKey(data, 'enter')) {
      if (this.loading) return;
      if (this.error) { void this.load(); return; }
      if (this.selected === items.length && this.nextCursor) { void this.load(this.nextCursor); return; }
      const item = items[this.selected]; if (item) this.onSelect?.(item);
    } else {
      this.search.handleInput(data);
      const query = this.search.getValue().trim();
      if (query !== this.query) {
        this.query = query; this.selected = 0;
        if (this.options.load) {
          this.controller?.abort(); ++this.version;
          this.loading = true; this.nextCursor = undefined;
          clearTimeout(this.timer); this.timer = setTimeout(() => { void this.load(); }, 180);
        }
      }
    }
    this.redraw();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y === 1) {
      const result = this.search.handleMouse({ ...event, x: Math.max(0, event.x - 1), y: 0, width: Math.max(1, event.width - 2) });
      if (result?.handled) return { ...result, focus: true };
    }
    if (event.type === 'wheel') {
      this.pressedValue = undefined;
      this.handleInput((event.wheelDelta ?? 0) < 0 ? '\x1b[A' : '\x1b[B');
      return { handled: true, render: true };
    }
    const row = this.renderedRows[event.y - 2];
    if (!row || this.loading || this.error || event.button !== 'left') return undefined;
    const items = this.visibleItems();
    const value = event.type === 'click' ? this.pressedValue ?? row.value : row.value;
    const index = value === '__more__' ? items.length : items.findIndex((item) => item.value === value);
    if (index < 0) return { handled: true };
    if (event.type === 'press') {
      this.pressedValue = row.value;
      this.selected = index; this.redraw();
      return { handled: true, focus: true, render: true };
    }
    if (event.type === 'click') {
      this.pressedValue = undefined;
      this.selected = index; this.handleInput('\r');
      return { handled: true, render: true };
    }
    return undefined;
  }
  render(width: number) {
    const inner = Math.max(1, width - 2);
    const line = (text: string) => truncateToWidth(' ' + text, width, '…');
    const items = this.visibleItems();
    const all = this.nextCursor ? [...items, { value: '__more__', label: '加载更多会话', description: 'Enter 继续读取下一页' }] : items;
    const height = Math.max(4, this.height());
    const detail = height >= 6;
    this.pageSize = Math.max(1, Math.min(6, height - 2 - Number(detail)));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.pageSize / 2), all.length - this.pageSize));
    const rows = all.slice(start, start + this.pageSize);
    this.renderedRows = rows;
    const count = this.loading ? '读取中…' : `${items.length} 项${this.nextCursor ? ' +' : ''}`;
    const title = `─ ${inline(this.options.title)} `;
    const suffix = ` ${count}`;
    // Heading continues the input border without a floating box or side walls.
    const heading = cyan(bold(truncateToWidth(title, Math.max(1, inner - visibleWidth(suffix) - 2), '…')));
    const lines = [line(heading + dim('─'.repeat(Math.max(1, inner - visibleWidth(heading) - visibleWidth(suffix))) + suffix)),
      line(this.search.render(inner)[0] ?? '')];
    if (this.error) lines.push(line(amber(inline(this.error))), line(dim('Enter 重试 · Esc 返回')));
    else if (!rows.length) lines.push(line(dim(this.loading ? '正在读取…' : this.query ? '没有匹配结果，试试其他关键词' : '暂无记录')));
    else for (const [i, item] of rows.entries()) {
      const selected = start + i === this.selected;
      const label = (selected ? cyan('› ') : '  ') + (selected ? bold(inline(item.label)) : inline(item.label)) + (item.current ? cyan('  ● 当前') : '');
      lines.push(line(label));
    }
    const selectedItem = all[this.selected];
    if (detail && !this.error) lines.push(line(dim(inline(selectedItem?.description || selectedItem?.detail || this.options.subtitle || ''))));
    return lines;
  }
}
