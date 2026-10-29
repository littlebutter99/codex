import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export type Message = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};

/** Codex stdio RPC: response IDs, notifications and server requests are distinct. */
export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private stopped = false;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(binary: string, args = ['app-server'], env: NodeJS.ProcessEnv = process.env) {
    super();
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        const message: Message = JSON.parse(line);
        if (message.method) {
          this.emit(message.id === undefined ? 'notification' : 'request', message);
        } else if (typeof message.id === 'number') {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        }
      } catch (error) {
        this.fail(new Error(`Invalid app-server message: ${String(error)}`));
        this.child.kill();
      }
    });
    this.child.stderr.on('data', (chunk) => this.emit('diagnostic', chunk.toString()));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      lines.close();
      this.fail(new Error(`Codex exited (${signal ?? code})`));
    });
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  send(message: Message) {
    if (this.stopped) throw new Error('Codex connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Codex connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'dicode', title: 'Dicode', version: '0.1.0' },
    });
    this.send({ method: 'initialized' });
    return result;
  }

  respond(id: string | number, result: unknown) { this.send({ id, result }); }
  unsupported(id: string | number, method: string) {
    this.send({ id, error: { code: -32601, message: `Unsupported client method: ${method}` } });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.fail(new Error('Client closed'));
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
}
