import { randomUUID } from "node:crypto";

export type PermissionRequest = {
  id: string;
  toolName: string;
  input: unknown;
};

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

type Pending = PermissionRequest & {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
};

/**
 * Holds tool-permission questions from Claude Code (`--permission-prompt-tool`) until a
 * person answers them in the chat panel. Unanswered questions are denied, never allowed.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly rememberedTools = new Set<string>();

  constructor(
    private readonly onRequest: (request: PermissionRequest) => void,
    private readonly timeoutMs = 5 * 60_000
  ) {}

  ask(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (this.rememberedTools.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, { behavior: "deny", message: "No answer from the EasyEDA chat panel; the action was not run." });
      }, this.timeoutMs);
      this.pending.set(id, { id, toolName, input, resolve, timer });
      this.onRequest({ id, toolName, input });
    });
  }

  /** `remember` allows the same tool without asking until `forget` (a new or switched conversation). */
  answer(id: string, allow: boolean, remember = false): boolean {
    const request = this.pending.get(id);
    if (!request) {
      return false;
    }
    if (allow && remember) {
      this.rememberedTools.add(request.toolName);
    }
    return this.settle(id, allow
      ? { behavior: "allow", updatedInput: request.input }
      : { behavior: "deny", message: "The user denied this action in the EasyEDA chat panel." });
  }

  denyAll(message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { behavior: "deny", message });
    }
  }

  forget(): void {
    this.rememberedTools.clear();
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map(({ id, toolName, input }) => ({ id, toolName, input }));
  }

  private settle(id: string, decision: PermissionDecision): boolean {
    const request = this.pending.get(id);
    if (!request) {
      return false;
    }
    clearTimeout(request.timer);
    this.pending.delete(id);
    request.resolve(decision);
    return true;
  }
}
