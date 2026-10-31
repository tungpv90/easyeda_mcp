import { describe, expect, it, vi } from "vitest";
import { PermissionBroker, type PermissionRequest } from "./permissions.js";

describe("PermissionBroker", () => {
  it("allows with the original input when the user approves", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const decision = broker.ask("mcp__easyeda-pro__easyeda_confirmed_action", { action: "save" });
    expect(requests).toHaveLength(1);
    expect(broker.list()).toHaveLength(1);
    expect(broker.answer(requests[0].id, true)).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { action: "save" } });
    expect(broker.list()).toHaveLength(0);
  });

  it("denies when the user rejects, and ignores unknown or repeated answers", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const decision = broker.ask("tool", {});
    broker.answer(requests[0].id, false);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.answer(requests[0].id, true)).toBe(false);
    expect(broker.answer("unknown", true)).toBe(false);
  });

  it("denies unanswered requests after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker(() => undefined, 1_000);
      const decision = broker.ask("tool", {});
      vi.advanceTimersByTime(1_000);
      await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers 'allow for this chat' per tool until forget", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const first = broker.ask("mcp__easyeda-copilot__run_pcb_router_dsl", { a: 1 });
    broker.answer(requests[0].id, true, true);
    await expect(first).resolves.toMatchObject({ behavior: "allow" });

    await expect(broker.ask("mcp__easyeda-copilot__run_pcb_router_dsl", { a: 2 })).resolves.toEqual({ behavior: "allow", updatedInput: { a: 2 } });
    expect(requests).toHaveLength(1);

    void broker.ask("mcp__easyeda-copilot__other_tool", {});
    expect(requests).toHaveLength(2);

    broker.forget();
    void broker.ask("mcp__easyeda-copilot__run_pcb_router_dsl", {});
    expect(requests).toHaveLength(3);
    broker.denyAll("done");
  });

  it("denies everything pending on denyAll", async () => {
    const broker = new PermissionBroker(() => undefined);
    const first = broker.ask("a", {});
    const second = broker.ask("b", {});
    broker.denyAll("stopped");
    await expect(first).resolves.toEqual({ behavior: "deny", message: "stopped" });
    await expect(second).resolves.toEqual({ behavior: "deny", message: "stopped" });
  });
});
