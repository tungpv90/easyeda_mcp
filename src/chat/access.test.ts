import { describe, expect, it } from "vitest";
import { createAccessPolicy, isLoopbackHost, isOriginAllowed } from "./access.js";
import { autoApprovedToolNames, listEasyEdaTools } from "./toolCatalog.js";

describe("chat access policy", () => {
  it("allows EasyEDA Pro, the host's own page and non-browser clients", () => {
    const policy = createAccessPolicy(8766, {});
    expect(isOriginAllowed(policy, "https://pro.easyeda.com")).toBe(true);
    expect(isOriginAllowed(policy, "https://pro.lceda.cn")).toBe(true);
    expect(isOriginAllowed(policy, "http://127.0.0.1:8766")).toBe(true);
    expect(isOriginAllowed(policy, undefined)).toBe(true);
  });

  it("rejects other web origins and the opaque null origin", () => {
    const policy = createAccessPolicy(8766, {});
    expect(isOriginAllowed(policy, "https://evil.example")).toBe(false);
    expect(isOriginAllowed(policy, "null")).toBe(false);
    expect(isOriginAllowed(policy, "http://127.0.0.1:9999")).toBe(false);
  });

  it("adds origins from EASYEDA_CHAT_ALLOWED_ORIGINS", () => {
    const policy = createAccessPolicy(8766, { EASYEDA_CHAT_ALLOWED_ORIGINS: "app://easyeda, null" });
    expect(isOriginAllowed(policy, "app://easyeda")).toBe(true);
    expect(isOriginAllowed(policy, "null")).toBe(true);
    expect(isOriginAllowed(createAccessPolicy(8766, { EASYEDA_CHAT_ALLOWED_ORIGINS: "*" }), "https://any.example")).toBe(true);
  });

  it("only accepts loopback Host headers for the listening port", () => {
    expect(isLoopbackHost("127.0.0.1:8766", 8766)).toBe(true);
    expect(isLoopbackHost("localhost:8766", 8766)).toBe(true);
    expect(isLoopbackHost("evil.example:8766", 8766)).toBe(false);
    expect(isLoopbackHost("127.0.0.1:80", 8766)).toBe(false);
    expect(isLoopbackHost(undefined, 8766)).toBe(false);
  });
});

describe("tool catalog", () => {
  it("auto-approves read-only tools but never the mutating confirmed action", () => {
    const tools = listEasyEdaTools();
    expect(tools.find((tool) => tool.name === "easyeda_get_context")?.readOnly).toBe(true);
    expect(tools.find((tool) => tool.name === "easyeda_confirmed_action")?.readOnly).toBe(false);

    const approved = autoApprovedToolNames("easyeda-pro", tools);
    expect(approved).toContain("mcp__easyeda-pro__easyeda_get_context");
    expect(approved).not.toContain("mcp__easyeda-pro__easyeda_confirmed_action");
  });
});
