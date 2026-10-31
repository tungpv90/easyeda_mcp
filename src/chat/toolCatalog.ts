import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import { registerEasyEdaTools } from "../mcp/registerTools.js";

export type ToolCatalogEntry = {
  name: string;
  readOnly: boolean;
};

/** Lists the EasyEDA tools and their read-only annotation without starting a server. */
export function listEasyEdaTools(): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  const recorder = {
    registerTool(name: string, config: { annotations?: { readOnlyHint?: boolean } }) {
      entries.push({ name, readOnly: config.annotations?.readOnlyHint === true });
    }
  };
  registerEasyEdaTools(recorder as unknown as McpServer, {} as EasyEdaBridge);
  return entries;
}

/** Claude Code tool names for read-only tools, which run without asking the user. */
export function autoApprovedToolNames(mcpServerName: string, tools = listEasyEdaTools()): string[] {
  return tools.filter((tool) => tool.readOnly).map((tool) => `mcp__${mcpServerName}__${tool.name}`);
}
