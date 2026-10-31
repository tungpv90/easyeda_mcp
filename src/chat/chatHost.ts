import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer, WebSocket } from "ws";
import * as z from "zod/v4";
import { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import { createMcpServer } from "../mcp/server.js";
import { MCP_SERVER_VERSION } from "../version.js";
import { createAccessPolicy, isLoopbackHost, isOriginAllowed, type AccessPolicy } from "./access.js";
import {
  ClaudeSession,
  extractUrls,
  readClaudeAuthStatus,
  resolveClaudeExecutable,
  runClaudeLogout,
  startClaudeLogin,
  type ClaudeAuthStatus,
  type ClaudeExecutable,
  type ClaudeLoginProcess
} from "./claudeCli.js";
import { listReadOnlyTools, loadExtraMcpServers, type McpServerConfig } from "./extraServers.js";
import { ConversationStore, isConversationId, type ConversationSummary } from "./history.js";
import { PermissionBroker, type PermissionRequest } from "./permissions.js";
import type { ChatEvent } from "./streamEvents.js";
import { autoApprovedToolNames } from "./toolCatalog.js";

export const DEFAULT_CHAT_PORT = 8766;
export const CHAT_MCP_SERVER_NAME = "easyeda-pro";
export const CHAT_PERMISSION_SERVER_NAME = "easyeda-chat";
export const CHAT_PERMISSION_TOOL = `mcp__${CHAT_PERMISSION_SERVER_NAME}__permission_prompt`;

const MAX_TRANSCRIPT_EVENTS = 2_000;
const STATUS_POLL_MS = 3_000;

const SYSTEM_PROMPT = [
  "You are the assistant in the EasyEDA Pro chat panel. The user is looking at a live EasyEDA Pro project.",
  `Inspect the project with the mcp__${CHAT_MCP_SERVER_NAME}__* tools before answering; never guess designators, nets or pins.`,
  "Other EasyEDA MCP servers may also be connected (for example easyeda-copilot, which edits schematics, places components and routes PCBs). Use whichever connected tools fit the request, and prefer them for edits.",
  "You have no shell, file or web tools.",
  "The user approves every project-changing tool call in the panel. Explain what will change before calling it.",
  "If no connected tool can make a requested change, say so plainly instead of pretending.",
  "Reply in the user's language. Keep answers short and use Markdown."
].join("\n");

/** Messages the panel sends to the host. */
export type ChatClientMessage =
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "new" }
  | { type: "set_model"; model?: string }
  | { type: "permission_response"; id: string; allow: boolean; remember?: boolean }
  | { type: "refresh" }
  | { type: "login" }
  | { type: "cancel_login" }
  | { type: "logout" }
  | { type: "list_history" }
  | { type: "open_history"; id: string }
  | { type: "delete_history"; id: string }
  | { type: "panel_width"; width: number; reopen?: boolean };

/** Messages the host sends to the panel, besides the forwarded ChatEvents. */
export type ChatHostMessage =
  | ChatEvent
  | { type: "user_message"; text: string }
  | { type: "status"; status: ChatStatus }
  | { type: "history"; events: ChatHostMessage[] }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; id: string }
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "login_output"; text: string; urls: string[] }
  | { type: "login_finished"; ok: boolean; message: string }
  | { type: "history_list"; items: ConversationSummary[] };

export type ChatStatus = {
  claude: ClaudeAuthStatus;
  easyeda: {
    connected: boolean;
    documentType?: string;
    documentName?: string;
    projectName?: string;
  };
  busy: boolean;
  loginInProgress: boolean;
  mcpServers: string[];
  model?: string;
  sessionId?: string;
};

export type ChatHostOptions = {
  port?: number;
  model?: string;
  bridge?: EasyEdaBridge;
  workDir?: string;
  uiHtmlPath?: string;
  claudeExecutable?: ClaudeExecutable;
  /** Also offer other EasyEDA MCP servers (mcp-servers.json, or detected in Claude Code's config). */
  extraMcp?: boolean;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "error" | "warn" | "info">;
};

export class ChatHost {
  private readonly requestedPort: number;
  private readonly bridge: EasyEdaBridge;
  private readonly workDir: string;
  private readonly uiHtmlPath: string;
  private readonly executable: ClaudeExecutable;
  private readonly logger: Pick<Console, "error" | "warn" | "info">;
  private readonly env: Record<string, string | undefined>;
  private readonly mcpToken = randomBytes(24).toString("hex");
  private readonly broker: PermissionBroker;
  private readonly clients = new Set<WebSocket>();
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private policy?: AccessPolicy;
  private statusTimer?: NodeJS.Timeout;
  private lastStatusJson = "";

  private session?: ClaudeSession;
  private login?: ClaudeLoginProcess;
  private sessionModel?: string;
  private sessionId?: string;
  private model?: string;
  private busy = false;
  private sawSessionInit = false;
  private stderrTail = "";
  private transcript: ChatHostMessage[] = [];
  private conversationCreatedAt = new Date().toISOString();
  private saveTimer?: NodeJS.Timeout;
  private readonly history: ConversationStore<ChatHostMessage>;
  private readonly extraMcp: boolean;
  private readonly homeDir?: string;
  private extraServers: Record<string, McpServerConfig> = {};
  private extraAllowedTools: string[] = [];
  private auth: ClaudeAuthStatus = { installed: false, loggedIn: false };

  constructor(options: ChatHostOptions = {}) {
    this.env = options.env ?? process.env;
    this.requestedPort = options.port ?? (Number(this.env.EASYEDA_CHAT_PORT) || DEFAULT_CHAT_PORT);
    this.model = options.model;
    this.logger = options.logger ?? console;
    this.bridge = options.bridge ?? new EasyEdaBridge({ logger: this.logger });
    this.workDir = options.workDir ?? path.join(os.homedir(), ".easyeda-pro-mcp", "chat");
    this.uiHtmlPath = options.uiHtmlPath ?? resolveChatHtmlPath();
    this.executable = options.claudeExecutable ?? resolveClaudeExecutable(this.env);
    this.history = new ConversationStore(path.join(this.workDir, "history"));
    this.extraMcp = options.extraMcp ?? true;
    this.homeDir = options.homeDir;
    this.broker = new PermissionBroker((request) => {
      this.broadcast({ type: "permission_request", request });
    });
  }

  get port(): number {
    const address = this.httpServer?.address();
    return typeof address === "object" && address ? address.port : this.requestedPort;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  async start(): Promise<void> {
    await this.bridge.start();

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttp(req, res).catch((error) => {
        this.logger.error(`[easyeda-chat] HTTP handler failed: ${String(error)}`);
        if (!res.headersSent) {
          sendText(res, 500, "Internal error");
        }
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      if (!this.isRequestAllowed(req) || new URL(req.url ?? "/", "http://localhost").pathname !== "/chat") {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.attachClient(ws));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once("error", reject);
      this.httpServer?.listen(this.requestedPort, "127.0.0.1", () => resolve());
    });
    this.policy = createAccessPolicy(this.port, this.env);
    if (this.extraMcp) {
      this.loadExtraServers();
    }
    this.writeSessionFiles();
    const latest = this.history.latest();
    if (latest) {
      this.restoreConversation(latest.id);
    }
    await this.refreshAuth();
    this.statusTimer = setInterval(() => this.broadcastStatusIfChanged(), STATUS_POLL_MS);
    this.logger.error(`[easyeda-chat] Chat host listening at ${this.url} (EasyEDA bridge ${this.bridge.endpoint})`);
  }

  async stop(): Promise<void> {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
    }
    this.broker.denyAll("The chat host is shutting down.");
    this.login?.cancel();
    this.saveConversation();
    const session = this.session;
    this.session = undefined;
    await session?.stop();
    for (const client of this.clients) {
      client.close(1001, "Chat host stopped");
    }
    this.wss?.close();
    await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()));
    await this.bridge.stop();
  }

  private isRequestAllowed(req: IncomingMessage): boolean {
    if (!isLoopbackHost(req.headers.host, this.port)) {
      this.logger.warn(`[easyeda-chat] Rejected request with Host "${req.headers.host ?? ""}".`);
      return false;
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!this.policy || !isOriginAllowed(this.policy, origin)) {
      this.logger.warn(`[easyeda-chat] Rejected Origin "${origin}". Add it to EASYEDA_CHAT_ALLOWED_ORIGINS if this is your EasyEDA Pro client.`);
      return false;
    }
    return true;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isRequestAllowed(req)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/chat.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(this.uiHtmlPath));
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.status()));
      return;
    }

    if (pathname === "/mcp" || pathname === "/mcp-chat") {
      if (req.headers.authorization !== `Bearer ${this.mcpToken}`) {
        sendText(res, 401, "Unauthorized");
        return;
      }
      const server = pathname === "/mcp" ? createMcpServer(this.bridge) : this.createPermissionServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    sendText(res, 404, "Not found");
  }

  private createPermissionServer(): McpServer {
    const server = new McpServer({ name: CHAT_PERMISSION_SERVER_NAME, version: MCP_SERVER_VERSION });
    server.registerTool(
      "permission_prompt",
      {
        description: "Internal: asks the person in the EasyEDA chat panel to approve a tool call. Do not call this directly.",
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          tool_use_id: z.string().optional()
        }
      },
      async ({ tool_name, input }) => {
        const decision = await this.broker.ask(tool_name, input ?? {});
        return { content: [{ type: "text" as const, text: JSON.stringify(decision) }] };
      }
    );
    return server;
  }

  private attachClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (data) => {
      let message: ChatClientMessage;
      try {
        message = JSON.parse(data.toString()) as ChatClientMessage;
      } catch {
        return;
      }
      void this.handleClientMessage(message).catch((error) => {
        this.send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    });

    this.send(ws, { type: "history", events: this.transcript });
    this.send(ws, { type: "history_list", items: this.history.list() });
    for (const request of this.broker.list()) {
      this.send(ws, { type: "permission_request", request });
    }
    this.send(ws, { type: "status", status: this.status() });
    void this.refreshAuth();
  }

  private async handleClientMessage(message: ChatClientMessage): Promise<void> {
    switch (message.type) {
      case "send": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) {
          return;
        }
        if (this.busy) {
          throw new Error("Claude is still answering. Wait for it to finish or press Stop.");
        }
        if (!this.auth.loggedIn) {
          await this.refreshAuth();
          if (!this.auth.loggedIn) {
            throw new Error(this.auth.error ?? "Claude Code is not signed in. Press \"Sign in with Claude\" first.");
          }
        }
        this.ensureSession().send(text);
        this.busy = true;
        this.record({ type: "user_message", text });
        this.broadcastStatusIfChanged();
        return;
      }
      case "stop":
        this.endSession("Stopped by the user.");
        return;
      case "new":
        this.endSession("Started a new conversation.");
        this.saveConversation();
        this.broker.forget();
        this.sessionId = undefined;
        this.transcript = [];
        this.conversationCreatedAt = new Date().toISOString();
        this.broadcast({ type: "reset" });
        this.broadcastStatusIfChanged();
        return;
      case "list_history":
        this.broadcast({ type: "history_list", items: this.history.list() });
        return;
      case "open_history":
        if (!isConversationId(message.id) || message.id === this.sessionId) {
          return;
        }
        if (this.busy) {
          throw new Error("Wait for Claude to finish answering before switching conversations.");
        }
        this.endSession();
        this.saveConversation();
        this.broker.forget();
        if (!this.restoreConversation(message.id)) {
          throw new Error("That conversation could not be found.");
        }
        this.broadcast({ type: "history", events: this.transcript });
        this.broadcastStatusIfChanged();
        return;
      case "delete_history":
        if (!isConversationId(message.id)) {
          return;
        }
        if (message.id === this.sessionId) {
          throw new Error("Open another conversation, or press New, before deleting this one.");
        }
        this.history.delete(message.id);
        this.broadcast({ type: "history_list", items: this.history.list() });
        return;
      case "panel_width": {
        const width = Number(message.width);
        if (!Number.isFinite(width) || width < 200 || width > 4_000) {
          return;
        }
        // The extension remembers the width and, when the panel could not resize itself, reopens it.
        try {
          await this.bridge.call("setChatPanelWidth", { width: Math.round(width), reopen: message.reopen === true });
        } catch (error) {
          // Remembering the width is best effort; only a failed reopen is worth showing.
          if (message.reopen === true) {
            throw new Error(`Could not resize the panel: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return;
      }
      case "set_model":
        this.model = typeof message.model === "string" && message.model.trim() ? message.model.trim() : undefined;
        if (!this.busy && this.session && this.sessionModel !== this.model) {
          this.endSession();
        }
        this.broadcastStatusIfChanged();
        return;
      case "permission_response":
        if (this.broker.answer(message.id, message.allow === true, message.remember === true)) {
          this.broadcast({ type: "permission_resolved", id: message.id });
        }
        return;
      case "refresh":
        await this.refreshAuth();
        return;
      case "login":
        this.startLogin();
        return;
      case "cancel_login":
        this.login?.cancel();
        return;
      case "logout":
        if (this.busy || this.login) {
          throw new Error("Wait for the current answer or sign-in to finish before signing out.");
        }
        this.endSession();
        await runClaudeLogout(this.executable);
        await this.refreshAuth();
        return;
    }
  }

  private ensureSession(): ClaudeSession {
    if (this.session?.alive) {
      return this.session;
    }
    this.stderrTail = "";
    this.sessionModel = this.model;
    this.sawSessionInit = false;
    const resumeSessionId = this.sessionId;
    const session = new ClaudeSession({
      cwd: this.workDir,
      executable: this.executable,
      mcpConfigPath: path.join(this.workDir, "mcp-config.json"),
      systemPromptPath: path.join(this.workDir, "system-prompt.md"),
      allowedTools: [...autoApprovedToolNames(CHAT_MCP_SERVER_NAME), ...this.extraAllowedTools],
      permissionPromptTool: CHAT_PERMISSION_TOOL,
      model: this.model,
      resumeSessionId,
      onEvent: (event) => this.handleClaudeEvent(event),
      onStderr: (text) => {
        this.stderrTail = (this.stderrTail + text).slice(-2_000);
      },
      onExit: (code) => {
        if (this.session !== session) {
          return;
        }
        this.session = undefined;
        if (this.busy) {
          this.busy = false;
          this.broker.denyAll("Claude Code exited.");
          if (resumeSessionId && !this.sawSessionInit) {
            // Claude Code no longer has this session (for example it was cleaned up); keep the
            // transcript visible but continue in a fresh Claude session on the next message.
            this.sessionId = undefined;
            this.record({ type: "error", message: "Claude Code could not reopen this conversation's context. Send your message again to continue in a new session." });
          } else {
            this.record({ type: "error", message: `Claude Code exited (code ${code ?? "?"}). ${this.stderrTail.trim()}`.trim() });
          }
          this.broadcastStatusIfChanged();
        }
      }
    });
    this.session = session;
    return session;
  }

  private endSession(reason?: string): void {
    const session = this.session;
    this.session = undefined;
    this.broker.denyAll(reason ?? "The conversation was restarted.");
    void session?.stop();
    if (this.busy) {
      this.busy = false;
      this.record({ type: "turn_end", isError: true, subtype: "interrupted", text: reason });
    }
    this.broadcastStatusIfChanged();
  }

  private handleClaudeEvent(event: ChatEvent): void {
    if (event.type === "session") {
      this.sawSessionInit = true;
      if (this.sessionId && this.sessionId !== event.sessionId) {
        // Resuming produced a new session id: move the saved transcript to it.
        this.history.delete(this.sessionId);
      }
      this.sessionId = event.sessionId;
      this.scheduleSave();
      const failed = event.mcpServers.filter((server) => server.status !== "connected");
      if (failed.length > 0) {
        this.record({ type: "error", message: `MCP server not connected: ${failed.map((server) => `${server.name} (${server.status})`).join(", ")}` });
      }
      this.broadcastStatusIfChanged();
      return;
    }
    if (event.type === "text_delta" || event.type === "usage") {
      // Deltas are transient; the full assistant_text that follows is what gets replayed.
      this.broadcast(event);
      return;
    }
    if (event.type === "turn_end") {
      this.busy = false;
      this.record(event);
      this.broadcastStatusIfChanged();
      return;
    }
    this.record(event);
  }

  private record(message: ChatHostMessage): void {
    this.transcript.push(message);
    if (this.transcript.length > MAX_TRANSCRIPT_EVENTS) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT_EVENTS);
    }
    this.broadcast(message);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.saveConversation(), 300);
  }

  private saveConversation(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!isConversationId(this.sessionId) || !this.transcript.some((event) => event.type === "user_message")) {
      return;
    }
    try {
      const { created } = this.history.save({
        id: this.sessionId,
        createdAt: this.conversationCreatedAt,
        model: this.model,
        events: this.transcript
      });
      if (created) {
        this.broadcast({ type: "history_list", items: this.history.list() });
      }
    } catch (error) {
      this.logger.warn(`[easyeda-chat] Could not save chat history: ${String(error)}`);
    }
  }

  private restoreConversation(id: string): boolean {
    const stored = this.history.load(id);
    if (!stored) {
      return false;
    }
    this.sessionId = stored.id;
    this.transcript = Array.isArray(stored.events) ? stored.events : [];
    this.conversationCreatedAt = stored.createdAt ?? stored.updatedAt;
    return true;
  }

  /** Runs Claude Code's own browser sign-in and relays its output, such as the sign-in URL. */
  private startLogin(): void {
    if (this.login) {
      return;
    }
    if (!this.auth.installed) {
      throw new Error(this.auth.error ?? "Claude Code CLI was not found.");
    }
    const login = startClaudeLogin(this.executable, (raw) => {
      const text = stripAnsi(raw);
      if (text.trim()) {
        this.broadcast({ type: "login_output", text, urls: extractUrls(text) });
      }
    });
    this.login = login;
    this.broadcastStatusIfChanged();
    void login.done.then(async (code) => {
      this.login = undefined;
      await this.refreshAuth();
      const ok = code === 0 && this.auth.loggedIn;
      this.broadcast({
        type: "login_finished",
        ok,
        message: ok
          ? `Signed in to Claude${this.auth.subscriptionType ? ` (${this.auth.subscriptionType})` : ""}.`
          : "Sign-in did not finish. Try again, or run `claude auth login` in a terminal."
      });
      this.broadcastStatusIfChanged();
    });
  }

  private async refreshAuth(): Promise<void> {
    this.auth = await readClaudeAuthStatus(this.executable);
    this.broadcastStatusIfChanged();
  }

  private status(): ChatStatus {
    const bridgeStatus = this.bridge.getStatus();
    return {
      claude: this.auth,
      easyeda: {
        connected: bridgeStatus.connected,
        documentType: bridgeStatus.activeDocumentType,
        documentName: bridgeStatus.documentName,
        projectName: bridgeStatus.projectName
      },
      busy: this.busy,
      loginInProgress: Boolean(this.login),
      mcpServers: [CHAT_MCP_SERVER_NAME, ...Object.keys(this.extraServers)],
      model: this.model,
      sessionId: this.sessionId
    };
  }

  private broadcastStatusIfChanged(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatusJson) {
      return;
    }
    this.lastStatusJson = json;
    this.broadcast({ type: "status", status });
  }

  private broadcast(message: ChatHostMessage): void {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  private send(ws: WebSocket, message: ChatHostMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private loadExtraServers(): void {
    const extra = loadExtraMcpServers({
      workDir: this.workDir,
      homeDir: this.homeDir,
      reservedNames: [CHAT_MCP_SERVER_NAME, CHAT_PERMISSION_SERVER_NAME]
    });
    this.extraServers = extra.servers;
    const names = Object.keys(extra.servers);
    if (names.length === 0) {
      this.logger.error(`[easyeda-chat] No other EasyEDA MCP servers found. To add some, list them in ${path.join(this.workDir, "mcp-servers.json")}.`);
      return;
    }
    this.logger.error(`[easyeda-chat] Also offering MCP servers from ${extra.sourcePath}: ${names.join(", ")}`);

    // Read-only discovery spawns each server once; until it finishes, their tools just ask first.
    void Promise.all(names.map(async (name) => {
      try {
        const tools = await listReadOnlyTools(extra.servers[name]);
        return tools.map((tool) => `mcp__${name}__${tool}`);
      } catch (error) {
        this.logger.warn(`[easyeda-chat] Could not list tools of "${name}" (${String(error)}); each of its tools will ask first.`);
        return [];
      }
    })).then((lists) => {
      this.extraAllowedTools = lists.flat();
      this.logger.error(`[easyeda-chat] ${this.extraAllowedTools.length} read-only tools from other servers will run without asking.`);
      if (this.session?.alive && !this.busy) {
        // Pick up the new allow-list on the next message; the conversation resumes unchanged.
        this.endSession();
      }
    });
  }

  private writeSessionFiles(): void {
    fs.mkdirSync(this.workDir, { recursive: true });
    const base = `http://127.0.0.1:${this.port}`;
    const headers = { Authorization: `Bearer ${this.mcpToken}` };
    const mcpConfig = {
      mcpServers: {
        ...this.extraServers,
        [CHAT_MCP_SERVER_NAME]: { type: "http", url: `${base}/mcp`, headers },
        [CHAT_PERMISSION_SERVER_NAME]: { type: "http", url: `${base}/mcp-chat`, headers }
      }
    };
    fs.writeFileSync(path.join(this.workDir, "mcp-config.json"), JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(this.workDir, "system-prompt.md"), SYSTEM_PROMPT);
  }
}

export function resolveChatHtmlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Same relative location from src/chat (tests) and dist/chat (published package).
  return path.resolve(here, "..", "..", "extension", "iframe", "chat.html");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
