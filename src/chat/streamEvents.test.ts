import { describe, expect, it } from "vitest";
import { parseClaudeStreamLine } from "./streamEvents.js";

const line = (value: unknown) => JSON.stringify(value);

describe("parseClaudeStreamLine", () => {
  it("maps the init event to a session event with MCP server status", () => {
    expect(parseClaudeStreamLine(line({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "claude-sonnet-5-5",
      mcp_servers: [{ name: "easyeda-pro", status: "connected" }]
    }))).toEqual([{
      type: "session",
      sessionId: "s-1",
      model: "claude-sonnet-5-5",
      mcpServers: [{ name: "easyeda-pro", status: "connected" }]
    }]);
  });

  it("forwards text deltas and ignores other stream events", () => {
    expect(parseClaudeStreamLine(line({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }
    }))).toEqual([{ type: "text_delta", text: "Hel" }]);
    expect(parseClaudeStreamLine(line({ type: "stream_event", event: { type: "message_stop" } }))).toEqual([]);
  });

  it("splits assistant messages into text and tool_use events", () => {
    expect(parseClaudeStreamLine(line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking U1." },
          { type: "tool_use", id: "tu-1", name: "mcp__easyeda-pro__easyeda_find_component", input: { query: "U1" } }
        ]
      }
    }))).toEqual([
      { type: "assistant_text", text: "Checking U1." },
      { type: "tool_use", id: "tu-1", name: "mcp__easyeda-pro__easyeda_find_component", input: { query: "U1" } }
    ]);
  });

  it("maps tool results and truncates long output", () => {
    const [event] = parseClaudeStreamLine(line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true, content: [{ type: "text", text: "x".repeat(5_000) }] }] }
    }));
    expect(event).toMatchObject({ type: "tool_result", toolUseId: "tu-1", isError: true });
    expect((event as { text: string }).text.length).toBeLessThan(1_300);
  });

  it("reports subscription usage windows", () => {
    expect(parseClaudeStreamLine(line({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 10, status: "allowed" } }
      }
    }))).toEqual([{
      type: "usage",
      status: "allowed",
      fiveHour: { utilization: 0.05, resetsAt: 10, status: "allowed" },
      sevenDay: undefined
    }]);
  });

  it("maps the result event to turn_end", () => {
    expect(parseClaudeStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 12 })))
      .toEqual([{ type: "turn_end", isError: false, subtype: "success", text: "ok", durationMs: 12 }]);
  });

  it("drops sub-agent traffic, malformed lines and unknown events", () => {
    expect(parseClaudeStreamLine(line({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "a" }] } }))).toEqual([]);
    expect(parseClaudeStreamLine("not json")).toEqual([]);
    expect(parseClaudeStreamLine("{broken")).toEqual([]);
    expect(parseClaudeStreamLine(line({ type: "something_new" }))).toEqual([]);
  });
});
