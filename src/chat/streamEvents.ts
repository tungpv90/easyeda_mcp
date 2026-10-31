/**
 * Translates Claude Code `--output-format stream-json` lines into the small event
 * vocabulary the chat panel understands. Unknown events are dropped on purpose so
 * newer Claude Code releases cannot break the panel.
 */

export type ChatUsageWindow = {
  utilization?: number;
  resetsAt?: number;
  status?: string;
};

export type ChatEvent =
  | { type: "session"; sessionId: string; model?: string; mcpServers: Array<{ name: string; status: string }> }
  | { type: "text_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { type: "usage"; status?: string; fiveHour?: ChatUsageWindow; sevenDay?: ChatUsageWindow }
  | { type: "turn_end"; isError: boolean; subtype?: string; text?: string; durationMs?: number };

const TOOL_RESULT_PREVIEW_CHARS = 1_200;

export function parseClaudeStreamLine(line: string): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return [];
  }

  let message: Record<string, any>;
  try {
    message = JSON.parse(trimmed) as Record<string, any>;
  } catch {
    return [];
  }

  // Sub-agent traffic would interleave with the main answer; the panel only shows the top level.
  if (message.parent_tool_use_id) {
    return [];
  }

  switch (message.type) {
    case "system":
      if (message.subtype === "init" && typeof message.session_id === "string") {
        return [{
          type: "session",
          sessionId: message.session_id,
          model: typeof message.model === "string" ? message.model : undefined,
          mcpServers: Array.isArray(message.mcp_servers)
            ? message.mcp_servers.map((server: Record<string, unknown>) => ({
              name: String(server.name ?? ""),
              status: String(server.status ?? "unknown")
            }))
            : []
        }];
      }
      return [];

    case "stream_event": {
      const event = message.event as Record<string, any> | undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        return [{ type: "text_delta", text: event.delta.text }];
      }
      return [];
    }

    case "assistant":
      return contentBlocks(message.message).flatMap((block): ChatEvent[] => {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          return [{ type: "assistant_text", text: block.text }];
        }
        if (block.type === "tool_use" && typeof block.id === "string") {
          return [{ type: "tool_use", id: block.id, name: String(block.name ?? "tool"), input: block.input }];
        }
        return [];
      });

    case "user":
      return contentBlocks(message.message).flatMap((block): ChatEvent[] => {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
          return [];
        }
        return [{
          type: "tool_result",
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          text: truncate(toolResultText(block.content), TOOL_RESULT_PREVIEW_CHARS)
        }];
      });

    case "rate_limit_event": {
      const info = message.rate_limit_info as Record<string, any> | undefined;
      if (!info) {
        return [];
      }
      return [{
        type: "usage",
        status: typeof info.status === "string" ? info.status : undefined,
        fiveHour: usageWindow(info.unifiedWindows?.five_hour),
        sevenDay: usageWindow(info.unifiedWindows?.seven_day)
      }];
    }

    case "result":
      return [{
        type: "turn_end",
        isError: message.is_error === true,
        subtype: typeof message.subtype === "string" ? message.subtype : undefined,
        text: typeof message.result === "string" ? message.result : undefined,
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : undefined
      }];

    default:
      return [];
  }
}

function contentBlocks(message: unknown): Array<Record<string, any>> {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function usageWindow(value: unknown): ChatUsageWindow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const window = value as Record<string, unknown>;
  return {
    utilization: typeof window.utilization === "number" ? window.utilization : undefined,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : undefined,
    status: typeof window.status === "string" ? window.status : undefined
  };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
