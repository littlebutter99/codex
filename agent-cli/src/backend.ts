import { EventEmitter } from 'node:events';
import { CodexClient, type Message } from './client.ts';
import { AgentSession } from './session.ts';
import { ApprovalQueue, type Ask } from './approvals.ts';
import { runtimeOptions, type DeepSeekProfile } from './auth.ts';

/** One runtime per provider; replacement is prepared before disposing the old one. */
export class Backend extends EventEmitter {
  readonly client: CodexClient;
  readonly session: AgentSession;
  readonly approvals: ApprovalQueue;
  private closed = false;
  constructor(options: {
    binary: string; cwd: string; profile?: DeepSeekProfile; catalogPath: string;
    model?: string; ask: Ask; report: (error: Error) => void;
  }) {
    super();
    const runtime = runtimeOptions(options.profile, options.catalogPath, options.model);
    this.client = new CodexClient(options.binary, runtime.args, runtime.env);
    this.session = new AgentSession(this.client, options.cwd, options.model);
    this.approvals = new ApprovalQueue(this.client, options.ask, options.report);
    this.client.on('request', (message: Message) => { if (!this.closed) this.approvals.enqueue(message); });
    this.client.on('diagnostic', (text) => this.emit('diagnostic', text));
    this.client.on('disconnect', (error) => { if (!this.closed) this.emit('disconnect', error); });
    this.session.on('failure', options.report);
    this.session.on('notification', (message: Message) => {
      if (this.closed) return;
      if (message.method === 'serverRequest/resolved') this.approvals.resolve(message.params.requestId);
      if (message.method === 'turn/completed') this.approvals.clear();
      this.emit('notification', message);
    });
  }
  async connect(threadId?: string) {
    try { await this.client.initialize(); await this.session.open(threadId); }
    catch (error) { await this.close(); throw error; }
  }
  async close() {
    this.closed = true;
    this.approvals.clear();
    await this.client.close();
  }
}
