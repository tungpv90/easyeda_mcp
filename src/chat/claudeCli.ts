import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseClaudeStreamLine, type ChatEvent } from "./streamEvents.js";

/**
 * Drives the user's own, locally installed and logged-in Claude Code CLI in headless
 * stream-json mode. Authentication stays entirely inside Claude Code: this module never
 * reads, copies or forwards Claude credentials.
 */

export type ClaudeExecutable = {
  command: string;
  shell: boolean;
  /** Arguments placed before the Claude Code arguments (used to run a script through node). */
  prefixArgs?: string[];
};

export type ClaudeAuthStatus = {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  version?: string;
  error?: string;
};

export type ClaudeArgsOptions = {
  mcpConfigPath: string;
  systemPromptPath: string;
  allowedTools: string[];
  permissionPromptTool: string;
  model?: string;
  resumeSessionId?: string;
};

type Env = Record<string, string | undefined>;

export function resolveClaudeExecutable(env: Env = process.env, platform: NodeJS.Platform = process.platform): ClaudeExecutable {
  const override = env.EASYEDA_CHAT_CLAUDE_BIN?.trim();
  if (override) {
    return { command: override, shell: platform === "win32" && /\.(cmd|bat)$/i.test(override) };
  }
  if (platform !== "win32") {
    return { command: "claude", shell: false };
  }

  // npm installs ship claude.cmd, which CreateProcess cannot start without a shell.
  const pathDirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const extension of [".exe", ".cmd"]) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, `claude${extension}`);
      if (fs.existsSync(candidate)) {
        return { command: candidate, shell: extension === ".cmd" };
      }
    }
  }
  return { command: "claude", shell: true };
}

export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Only the EasyEDA MCP tools: no shell, file or web tools from Claude Code itself.
    "--tools", "",
    // Ignore user/project settings so a personal bypassPermissions default cannot skip the panel's approval step.
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", options.mcpConfigPath,
    "--append-system-prompt-file", options.systemPromptPath,
    "--permission-prompt-tool", options.permissionPromptTool
  ];
  if (options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  return args;
}

export function quoteWindowsShellArg(arg: string): string {
  if (arg === "") {
    return '""';
  }
  if (!/[\s"&|<>^()%!]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

export function encodeUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] }
  });
}

export function parseAuthStatus(stdout: string): Omit<ClaudeAuthStatus, "installed" | "version"> {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined,
      email: typeof parsed.email === "string" ? parsed.email : undefined
    };
  } catch {
    return { loggedIn: false, error: "Could not read `claude auth status` output." };
  }
}

export async function readClaudeAuthStatus(executable = resolveClaudeExecutable()): Promise<ClaudeAuthStatus> {
  const version = await runOnce(executable, ["--version"]);
  if (version.code !== 0) {
    return {
      installed: false,
      loggedIn: false,
      error: "Claude Code CLI was not found. Install it from https://code.claude.com and run `claude` once to sign in."
    };
  }
  const status = await runOnce(executable, ["auth", "status"]);
  return {
    installed: true,
    version: version.stdout.trim().split(/\s+/)[0],
    ...parseAuthStatus(status.stdout)
  };
}

export type ClaudeLoginProcess = {
  done: Promise<number>;
  cancel: () => void;
};

/**
 * Runs Claude Code's own sign-in (`claude auth login --claudeai`). Claude Code opens the
 * browser and stores the login itself; this only relays its output (such as the sign-in URL).
 */
export function startClaudeLogin(
  executable: ClaudeExecutable,
  onOutput: (text: string) => void,
  timeoutMs = 10 * 60_000
): ClaudeLoginProcess {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnClaude(executable, ["auth", "login", "--claudeai"], process.cwd());
  } catch (error) {
    onOutput(error instanceof Error ? error.message : String(error));
    return { done: Promise.resolve(-1), cancel: () => undefined };
  }
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.on("data", (chunk) => onOutput(chunk.toString()));
  child.stderr.on("data", (chunk) => onOutput(chunk.toString()));
  const done = new Promise<number>((resolve) => {
    child.on("error", (error) => {
      onOutput(error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  return {
    done,
    cancel: () => {
      child.stdin.end();
      child.kill();
    }
  };
}

export async function runClaudeLogout(executable: ClaudeExecutable): Promise<boolean> {
  return (await runOnce(executable, ["auth", "logout"])).code === 0;
}

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https:\/\/[^\s"'<>`]+/g) ?? [])];
}

function runOnce(executable: ClaudeExecutable, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnClaude(executable, args, process.cwd());
    } catch {
      resolve({ code: -1, stdout });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

function spawnClaude(executable: ClaudeExecutable, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const env = { ...process.env };
  // An inherited key would silently switch billing from the subscription to the API.
  delete env.ANTHROPIC_API_KEY;
  const fullArgs = [...(executable.prefixArgs ?? []), ...args];
  if (executable.shell) {
    const commandLine = [executable.command, ...fullArgs].map(quoteWindowsShellArg).join(" ");
    return spawn(commandLine, { cwd, env, shell: true, windowsHide: true });
  }
  return spawn(executable.command, fullArgs, { cwd, env, windowsHide: true });
}

export type ClaudeSessionOptions = ClaudeArgsOptions & {
  cwd: string;
  executable?: ClaudeExecutable;
  onEvent: (event: ChatEvent) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
};

/** One long-lived `claude -p` process; each `send` is one user turn on the same conversation. */
export class ClaudeSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly viaShell: boolean;
  private readonly closed: Promise<void>;
  private exited = false;

  constructor(options: ClaudeSessionOptions) {
    fs.mkdirSync(options.cwd, { recursive: true });
    const executable = options.executable ?? resolveClaudeExecutable();
    this.viaShell = executable.shell;
    this.child = spawnClaude(executable, buildClaudeArgs(options), options.cwd);
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      for (const event of parseClaudeStreamLine(line)) {
        options.onEvent(event);
      }
    });
    this.child.stderr.on("data", (chunk) => options.onStderr?.(chunk.toString()));
    this.child.on("error", (error) => {
      options.onStderr?.(error.message);
    });
    this.child.on("close", (code) => {
      this.exited = true;
      options.onExit(code);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(text: string): void {
    this.child.stdin.write(`${encodeUserMessage(text)}\n`);
  }

  /** Ends the process (and, on Windows shells, its child tree) and waits briefly for it to exit. */
  stop(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    this.child.stdin.end();
    if (this.viaShell && process.platform === "win32" && this.child.pid) {
      // With shell:true the pid is cmd.exe; killing it alone would orphan claude.
      spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
    } else {
      this.child.kill();
    }
    return Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())]);
  }
}
