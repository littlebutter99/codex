import type { CodexClient, Message } from './client.ts';

export type Ask = (text: string, signal: AbortSignal) => Promise<string>;

/** Never interpret normal chat text as permission; only an explicit y grants it. */
export async function answerRequest(message: Message, ask: Ask, signal: AbortSignal) {
  const p = message.params ?? {};
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      const details = p.networkApprovalContext
        ? JSON.stringify(p.networkApprovalContext)
        : p.command ?? p.reason ?? p.itemId;
      const answer = await ask(`审批 ${message.method}\n${details}\n工作目录: ${p.cwd ?? p.grantRoot ?? '当前项目'}\n允许本次操作？[y/N] `, signal);
      const decision = answer.trim().toLowerCase() === 'y' ? 'accept' : 'decline';
      if (p.availableDecisions && !p.availableDecisions.includes(decision)) {
        throw new Error('服务器不支持该审批选择，请取消当前任务');
      }
      return { decision };
    }
    case 'item/permissions/requestApproval': {
      const answer = await ask(`权限申请\n${p.reason ?? ''}\n${JSON.stringify(p.permissions, null, 2)}\n授予本轮权限？[y/N] `, signal);
      const permissions = Object.fromEntries(Object.entries(p.permissions ?? {}).filter(([, value]) => value != null));
      return { permissions: answer.trim().toLowerCase() === 'y' ? permissions : {}, scope: 'turn' };
    }
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput': {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of p.questions) {
        const choices = (q.options ?? []).map((o: any, i: number) => `${i + 1}. ${o.label} ${o.description ?? ''}`).join('\n');
        const answer = await ask(`${q.question}\n${choices}\n请输入选项编号或文本: `, signal);
        const index = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1;
        answers[q.id] = { answers: [q.options?.[index]?.label ?? answer] };
      }
      return { answers };
    }
    case 'mcpServer/elicitation/request':
      // This first version does not implement arbitrary JSON-schema forms.
      return { action: 'decline', content: null };
    default:
      return undefined;
  }
}

export class ApprovalQueue {
  private controllers = new Map<string | number, AbortController>();
  private tail: Promise<void> = Promise.resolve();
  private client: CodexClient;
  private ask: Ask;
  private report: (error: Error) => void;
  constructor(client: CodexClient, ask: Ask, report: (error: Error) => void) {
    this.client = client;
    this.ask = ask;
    this.report = report;
  }

  enqueue(message: Message) {
    const id = message.id!;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.tail = this.tail.then(async () => {
      if (controller.signal.aborted) return;
      try {
        const answer = await answerRequest(message, this.ask, controller.signal);
        if (controller.signal.aborted) return;
        if (answer === undefined) this.client.unsupported(id, message.method!);
        else this.client.respond(id, answer);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.report(error as Error);
          this.client.send({ id, error: { code: -32603, message: String(error) } });
        }
      } finally {
        this.controllers.delete(id);
      }
    });
  }

  resolve(id: string | number) {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
  }

  clear() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
