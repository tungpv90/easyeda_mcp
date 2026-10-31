#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EasyEdaBridge } from "./bridge/EasyEdaBridge.js";
import { ChatHost } from "./chat/chatHost.js";
import { handleCliArgs, type ChatCommandOptions } from "./cli/cli.js";
import { installLifecycleHandlers } from "./lifecycle.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const cliResult = handleCliArgs(process.argv.slice(2));
  if (cliResult.handled) {
    process.exitCode = cliResult.exitCode;
    return;
  }

  if (cliResult.chat) {
    await runChatHost(cliResult.chat);
    return;
  }

  const bridge = new EasyEdaBridge();
  await bridge.start();

  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installLifecycleHandlers({ bridge, server, transport });
}

async function runChatHost(options: ChatCommandOptions): Promise<void> {
  const host = new ChatHost(options);
  try {
    await host.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error("[easyeda-chat] A port is already in use. Close AI clients that run easyeda-pro-mcp (they hold the bridge port 8765) or another chat host, then retry.");
      process.exit(1);
    }
    throw error;
  }
  console.error("[easyeda-chat] In EasyEDA Pro: MCP Bridge -> Connect, then MCP Bridge -> Claude Chat. Press Ctrl+C to stop.");

  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void host.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[easyeda-mcp] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
