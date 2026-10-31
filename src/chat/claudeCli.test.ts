import { describe, expect, it } from "vitest";
import { buildClaudeArgs, encodeUserMessage, extractUrls, parseAuthStatus, quoteWindowsShellArg, resolveClaudeExecutable } from "./claudeCli.js";

const baseOptions = {
  mcpConfigPath: "/tmp/mcp-config.json",
  systemPromptPath: "/tmp/system-prompt.md",
  allowedTools: ["mcp__easyeda-pro__easyeda_get_context", "mcp__easyeda-pro__easyeda_run_drc"],
  permissionPromptTool: "mcp__easyeda-chat__permission_prompt"
};

describe("buildClaudeArgs", () => {
  it("runs headless stream-json with only the EasyEDA MCP servers and no built-in tools", () => {
    const args = buildClaudeArgs(baseOptions);
    expect(args.slice(0, 1)).toEqual(["-p"]);
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--include-partial-messages", "--verbose"]));
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(baseOptions.mcpConfigPath);
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe(baseOptions.permissionPromptTool);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(baseOptions.allowedTools.join(","));
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("adds the model and resume session when given", () => {
    const args = buildClaudeArgs({ ...baseOptions, model: "sonnet", resumeSessionId: "abc" });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
  });
});

describe("quoteWindowsShellArg", () => {
  it("quotes empty values and values with spaces or shell metacharacters", () => {
    expect(quoteWindowsShellArg("")).toBe('""');
    expect(quoteWindowsShellArg("--verbose")).toBe("--verbose");
    expect(quoteWindowsShellArg("C:\\Users\\A B\\mcp.json")).toBe('"C:\\Users\\A B\\mcp.json"');
    expect(quoteWindowsShellArg("a&b")).toBe('"a&b"');
    expect(quoteWindowsShellArg('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("resolveClaudeExecutable", () => {
  it("prefers EASYEDA_CHAT_CLAUDE_BIN", () => {
    expect(resolveClaudeExecutable({ EASYEDA_CHAT_CLAUDE_BIN: "/opt/claude" }, "linux")).toEqual({ command: "/opt/claude", shell: false });
    expect(resolveClaudeExecutable({ EASYEDA_CHAT_CLAUDE_BIN: "C:\\npm\\claude.cmd" }, "win32")).toEqual({ command: "C:\\npm\\claude.cmd", shell: true });
  });

  it("uses claude from PATH on non-Windows platforms", () => {
    expect(resolveClaudeExecutable({}, "darwin")).toEqual({ command: "claude", shell: false });
  });
});

describe("parseAuthStatus", () => {
  it("reads subscription login details", () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "a@b.c" })))
      .toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "a@b.c" });
  });

  it("treats unreadable output as logged out", () => {
    expect(parseAuthStatus("Not logged in")).toMatchObject({ loggedIn: false });
  });
});

describe("extractUrls", () => {
  it("finds unique https URLs in login output", () => {
    expect(extractUrls("Visit https://claude.ai/oauth/authorize?x=1 or https://claude.ai/oauth/authorize?x=1\nthen paste the code"))
      .toEqual(["https://claude.ai/oauth/authorize?x=1"]);
    expect(extractUrls("no links here")).toEqual([]);
  });
});

describe("encodeUserMessage", () => {
  it("encodes one stream-json user message line", () => {
    expect(JSON.parse(encodeUserMessage("xin chào"))).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "xin chào" }] }
    });
  });
});
