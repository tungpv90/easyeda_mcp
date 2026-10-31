import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import { ChatHost, type ChatHostMessage } from "./chatHost.js";

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined };

// Stands in for the Claude Code CLI: answers --version / auth status, then echoes each stream-json turn.
const FAKE_SESSION_ID = "11111111-2222-4333-8444-555555555555";

// Login state lives in fake-auth.json next to the script (missing file = signed in).
const FAKE_CLAUDE = `
import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
const stateFile = new URL("./fake-auth.json", import.meta.url);
const loggedIn = () => !fs.existsSync(stateFile) || JSON.parse(fs.readFileSync(stateFile, "utf8")).loggedIn;
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ loggedIn: loggedIn(), authMethod: "claude.ai", subscriptionType: "pro" })); process.exit(0); }
if (args[0] === "auth" && args[1] === "login") {
  console.log("Opening browser to sign in: \\u001b[1mhttps://claude.ai/oauth/authorize?code=true\\u001b[0m");
  setTimeout(() => { fs.writeFileSync(stateFile, JSON.stringify({ loggedIn: true })); process.exit(0); }, 50);
} else if (args[0] === "auth" && args[1] === "logout") {
  fs.writeFileSync(stateFile, JSON.stringify({ loggedIn: false }));
  process.exit(0);
} else {
fs.writeFileSync("args.json", JSON.stringify(args));
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const resumed = args.indexOf("--resume") >= 0 ? args[args.indexOf("--resume") + 1] : undefined;
out({ type: "system", subtype: "init", session_id: resumed ?? "${FAKE_SESSION_ID}", model: "fake", mcp_servers: [] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content[0].text;
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "echo" } } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "echo: " + text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "echo: " + text });
});
}
`;

let workDir: string;
let host: ChatHost;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "easyeda-chat-test-"));
  const fakeClaude = path.join(workDir, "fake-claude.mjs");
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE);
  host = new ChatHost({
    port: 0,
    bridge: new EasyEdaBridge({ port: 0, logger: silent }),
    workDir,
    claudeExecutable: { command: process.execPath, shell: false, prefixArgs: [fakeClaude] },
    homeDir: workDir,
    env: {},
    logger: silent
  });
  await host.start();
});

afterAll(async () => {
  await host.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function request(options: { method?: string; path?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: host.port,
      method: options.method ?? "GET",
      path: options.path ?? "/",
      headers: options.headers
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function openChat(origin: string): Promise<{ ws: WebSocket; messages: ChatHostMessage[]; waitFor: (predicate: (message: ChatHostMessage) => boolean) => Promise<ChatHostMessage> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/chat`, { origin });
    const messages: ChatHostMessage[] = [];
    const waiters: Array<{ predicate: (message: ChatHostMessage) => boolean; resolve: (message: ChatHostMessage) => void }> = [];
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ChatHostMessage;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    const waitFor = (predicate: (message: ChatHostMessage) => boolean) => {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<ChatHostMessage>((done) => waiters.push({ predicate, resolve: done }));
    };
    ws.once("open", () => resolve({ ws, messages, waitFor }));
    ws.once("error", reject);
  });
}

describe("ChatHost", () => {
  it("serves the chat panel page", async () => {
    const response = await request({});
    expect(response.status).toBe(200);
    expect(response.body).toContain("<title>Claude Chat</title>");
  });

  it("rejects foreign origins and non-loopback Host headers", async () => {
    expect((await request({ headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await request({ headers: { Host: "evil.example" } })).status).toBe(403);
    await expect(openChat("https://evil.example")).rejects.toThrow(/403/);
  });

  it("requires the per-run token on the MCP endpoints", async () => {
    expect((await request({ method: "POST", path: "/mcp" })).status).toBe(401);
    expect((await request({ method: "POST", path: "/mcp-chat", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("runs a chat turn through the Claude Code CLI and streams it to the panel", async () => {
    const chat = await openChat("https://pro.easyeda.com");
    await chat.waitFor((message) => message.type === "status" && message.status.claude.loggedIn);

    chat.ws.send(JSON.stringify({ type: "send", text: "xin chào" }));
    await chat.waitFor((message) => message.type === "user_message" && message.text === "xin chào");
    await chat.waitFor((message) => message.type === "text_delta");
    await chat.waitFor((message) => message.type === "assistant_text" && message.text === "echo: xin chào");
    await chat.waitFor((message) => message.type === "turn_end" && !message.isError);
    await chat.waitFor((message) => message.type === "status" && message.status.sessionId === FAKE_SESSION_ID && !message.status.busy);

    const args = JSON.parse(fs.readFileSync(path.join(workDir, "args.json"), "utf8")) as string[];
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("easyeda_confirmed_action");

    const mcpConfig = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
    expect(mcpConfig.mcpServers["easyeda-pro"].url).toBe(`http://127.0.0.1:${host.port}/mcp`);
    expect(mcpConfig.mcpServers["easyeda-chat"].headers.Authorization).toMatch(/^Bearer [0-9a-f]{48}$/);

    // A second panel (for example after the iframe reloads) gets the conversation replayed.
    const second = await openChat("https://pro.easyeda.com");
    const history = await second.waitFor((message) => message.type === "history");
    expect(history.type === "history" && history.events.some((event) => event.type === "assistant_text")).toBe(true);

    chat.ws.close();
    second.ws.close();
  });

  it("saves conversations and restores the latest one after a restart", async () => {
    const chat = await openChat("https://pro.easyeda.com");
    await chat.waitFor((message) => message.type === "history_list" && message.items.some((item) => item.id === FAKE_SESSION_ID));
    const saved = JSON.parse(fs.readFileSync(path.join(workDir, "history", `${FAKE_SESSION_ID}.json`), "utf8"));
    expect(saved.title).toBe("xin chào");
    expect(saved.events.some((event: ChatHostMessage) => event.type === "assistant_text")).toBe(true);

    // "New" keeps the saved conversation and starts an empty one.
    chat.ws.send(JSON.stringify({ type: "new" }));
    await chat.waitFor((message) => message.type === "reset");
    chat.ws.close();

    const restarted = new ChatHost({
      port: 0,
      bridge: new EasyEdaBridge({ port: 0, logger: silent }),
      workDir,
      claudeExecutable: { command: process.execPath, shell: false, prefixArgs: [path.join(workDir, "fake-claude.mjs")] },
      homeDir: workDir,
      env: {},
      logger: silent
    });
    await restarted.start();
    try {
      const health = await new Promise<string>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: restarted.port, path: "/health" }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }).on("error", reject);
      });
      expect(JSON.parse(health).sessionId).toBe(FAKE_SESSION_ID);
    } finally {
      await restarted.stop();
    }
  });

  it("signs out and back in through Claude Code's own login from the panel", async () => {
    const chat = await openChat("https://pro.easyeda.com");
    await chat.waitFor((message) => message.type === "status" && message.status.claude.loggedIn);

    chat.ws.send(JSON.stringify({ type: "logout" }));
    await chat.waitFor((message) => message.type === "status" && !message.status.claude.loggedIn);

    chat.ws.send(JSON.stringify({ type: "send", text: "hi" }));
    const refused = await chat.waitFor((message) => message.type === "error");
    expect(refused.type === "error" && refused.message).toMatch(/Sign in with Claude/);

    chat.ws.send(JSON.stringify({ type: "login" }));
    const output = await chat.waitFor((message) => message.type === "login_output");
    expect(output.type === "login_output" && output.urls).toEqual(["https://claude.ai/oauth/authorize?code=true"]);
    const finished = await chat.waitFor((message) => message.type === "login_finished");
    expect(finished).toMatchObject({ ok: true, message: "Signed in to Claude (pro)." });
    await chat.waitFor((message) => message.type === "status" && message.status.claude.loggedIn && !message.status.loginInProgress);

    chat.ws.close();
  });
});
