import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../version.js";

/**
 * Other EasyEDA MCP servers (for example easyeda-copilot-mcp, which edits schematics and
 * places/routes PCBs) that the chat panel should offer alongside this project's tools.
 */

export type McpServerConfig = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type ExtraServers = {
  servers: Record<string, McpServerConfig>;
  source: "file" | "claude-code" | "none";
  sourcePath?: string;
};

export const EXTRA_SERVERS_FILE = "mcp-servers.json";

/**
 * Version of the easyeda-copilot client bundled in the extension (extension/vendor/easyeda-copilot).
 * An unversioned `npx easyeda-copilot-mcp` is pinned to it so server and client protocols match.
 */
export const COPILOT_VERSION = "1.3.2";

export function pinCopilotVersion(server: McpServerConfig): McpServerConfig {
  if (!server.args?.includes("easyeda-copilot-mcp")) {
    return server;
  }
  return { ...server, args: server.args.map((arg) => (arg === "easyeda-copilot-mcp" ? `easyeda-copilot-mcp@${COPILOT_VERSION}` : arg)) };
}

export function loadExtraMcpServers(options: {
  workDir: string;
  reservedNames: string[];
  homeDir?: string;
}): ExtraServers {
  const filePath = path.join(options.workDir, EXTRA_SERVERS_FILE);
  if (fs.existsSync(filePath)) {
    const parsed = readJson(filePath) as { mcpServers?: Record<string, McpServerConfig> } | undefined;
    return {
      servers: sanitizeServers(parsed?.mcpServers ?? {}, options.reservedNames, false),
      source: "file",
      sourcePath: filePath
    };
  }

  const claudeConfigPath = path.join(options.homeDir ?? os.homedir(), ".claude.json");
  const claudeConfig = readJson(claudeConfigPath) as ClaudeConfig | undefined;
  const detected = claudeConfig ? detectEasyEdaServers(claudeConfig) : {};
  const servers = sanitizeServers(detected, options.reservedNames, true);
  return Object.keys(servers).length > 0
    ? { servers, source: "claude-code", sourcePath: claudeConfigPath }
    : { servers: {}, source: "none" };
}

type ClaudeConfig = {
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>;
};

/** EasyEDA-related servers from Claude Code's user scope and every project scope. */
export function detectEasyEdaServers(config: ClaudeConfig): Record<string, McpServerConfig> {
  const found: Record<string, McpServerConfig> = {};
  const scopes = [config.mcpServers ?? {}, ...Object.values(config.projects ?? {}).map((project) => project?.mcpServers ?? {})];
  for (const scope of scopes) {
    for (const [name, server] of Object.entries(scope)) {
      if (!found[name] && /easyeda|lceda/i.test(`${name} ${describeServer(server)}`)) {
        found[name] = server;
      }
    }
  }
  return found;
}

/** This project's own stdio server would fight the chat host for the bridge port. */
export function isOwnServer(server: McpServerConfig): boolean {
  if (new RegExp(`(^|[/@\\s])${MCP_SERVER_NAME}(\\b|$)`).test(describeServer(server))) {
    return true;
  }
  // `setup --local` entries run `node <checkout>/dist/index.js`.
  return (server.args ?? []).some((arg) => {
    if (!/[\\/]dist[\\/]index\.js$/.test(arg)) {
      return false;
    }
    const manifest = readJson(path.join(path.dirname(path.dirname(arg)), "package.json")) as { name?: string } | undefined;
    return manifest?.name === "@vlabsoftware/easyeda-pro-mcp";
  });
}

function sanitizeServers(
  servers: Record<string, McpServerConfig>,
  reservedNames: string[],
  dropOwnServer: boolean
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object" || reservedNames.includes(name) || !/^[A-Za-z0-9_-]+$/.test(name)) {
      continue;
    }
    if (dropOwnServer && isOwnServer(server)) {
      continue;
    }
    if (!server.command && !server.url) {
      continue;
    }
    result[name] = pinCopilotVersion(server);
  }
  return result;
}

/**
 * Asks a stdio server for its tool list and returns the read-only ones (MCP readOnlyHint),
 * which the panel runs without asking. Anything else keeps the approval card.
 */
export async function listReadOnlyTools(server: McpServerConfig, timeoutMs = 90_000): Promise<string[]> {
  if (!server.command || (server.type && server.type !== "stdio")) {
    return [];
  }
  const client = new Client({ name: `${MCP_SERVER_NAME}-chat`, version: MCP_SERVER_VERSION });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: server.env ? { ...stringEnv(process.env), ...server.env } : undefined,
    stderr: "ignore"
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const listing = (async () => {
      await client.connect(transport);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          if (tool.annotations?.readOnlyHint === true) {
            names.push(tool.name);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out listing tools")), timeoutMs);
    });
    return await Promise.race([listing, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    await client.close().catch(() => undefined);
  }
}

function describeServer(server: McpServerConfig): string {
  return [server.command ?? "", ...(server.args ?? []), server.url ?? ""].join(" ");
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
