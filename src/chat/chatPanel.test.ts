import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Runs the chat panel's inline script against a permissive fake DOM and a fake WebSocket,
 * then feeds it host messages. It catches script-level breakage (for example a variable
 * that shadows the message handler), not layout problems.
 */

type FakeNode = Record<string | symbol, unknown>;

function fakeNode(store: Map<string, FakeNode>, name: string): FakeNode {
  const values: Record<string | symbol, unknown> = {};
  const node: FakeNode = new Proxy(function () {} as unknown as FakeNode, {
    get(_target, key) {
      if (key in values) {
        return values[key];
      }
      if (key === Symbol.toPrimitive) {
        return () => "";
      }
      if (key === "then") {
        return undefined;
      }
      if (key === "appendChild" || key === "insertAdjacentHTML") {
        return (child: unknown) => {
          ((values.appended ??= []) as unknown[]).push(child);
          return child;
        };
      }
      // Any other property is a callable fake, so DOM calls never throw.
      const child = fakeNode(store, `${name}.${String(key)}`);
      values[key] = child;
      return child;
    },
    set(_target, key, value) {
      values[key] = value;
      return true;
    },
    apply() {
      return fakeNode(store, `${name}()`);
    }
  });
  return node;
}

function loadPanel() {
  const html = fs.readFileSync(path.resolve("extension/iframe/chat.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) {
    throw new Error("chat.html has no inline script");
  }

  const elements = new Map<string, FakeNode>();
  const byId = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, fakeNode(elements, `#${id}`));
    }
    return elements.get(id)!;
  };
  const sockets: Array<{ sent: string[]; onopen?: () => void; onmessage?: (event: { data: string }) => void; readyState: number; send: (data: string) => void }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
  }
  const window = {
    localStorage: { getItem: () => null, setItem: () => undefined },
    screen: { availWidth: 1600 },
    frameElement: null,
    innerWidth: 420
  } as Record<string, unknown>;
  window.self = window;
  window.top = {};

  const context = vm.createContext({
    window,
    document: {
      getElementById: byId,
      createElement: (tag: string) => fakeNode(elements, `<${tag}>`),
      body: fakeNode(elements, "body"),
      activeElement: null
    },
    location: { protocol: "https:", hostname: "pro.easyeda.com", host: "pro.easyeda.com" },
    WebSocket: FakeWebSocket,
    CSS: { escape: (value: string) => value },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console
  });
  vm.runInContext(script, context);
  return { byId, sockets };
}

describe("chat panel script", () => {
  it("renders status, history and permission requests from the host", () => {
    const { byId, sockets } = loadPanel();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://127.0.0.1:8766/chat");
    sockets[0].onopen?.();

    const deliver = (message: unknown) => sockets[0].onmessage?.({ data: JSON.stringify(message) });
    expect(() => deliver({ type: "history", events: [{ type: "user_message", text: "hi" }, { type: "assistant_text", text: "**hello**" }] })).not.toThrow();
    expect(() => deliver({
      type: "status",
      status: {
        claude: { installed: true, loggedIn: true, subscriptionType: "pro" },
        easyeda: { connected: true, documentType: "schematic", documentName: "Main" },
        busy: true,
        loginInProgress: false,
        mcpServers: ["easyeda-pro", "easyeda-copilot"],
        model: "opus"
      }
    })).not.toThrow();
    expect(String(byId("claudeStatus").innerHTML)).toContain("Claude Pro");
    expect(String(byId("edaStatus").innerHTML)).toContain("SCHEMATIC: Main");
    expect(byId("servers").textContent).toBe("Tools: easyeda-pro, easyeda-copilot");
    expect(byId("send").textContent).toBe("Stop");

    const appendedBefore = ((byId("messages").appended as unknown[]) ?? []).length;
    expect(() => deliver({ type: "permission_request", request: { id: "p1", toolName: "mcp__easyeda-copilot__execute_js", input: { code: "return 1" } } })).not.toThrow();
    expect(((byId("messages").appended as unknown[]) ?? []).length).toBe(appendedBefore + 1);
  });
});
