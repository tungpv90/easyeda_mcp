import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COPILOT_VERSION, detectEasyEdaServers, isOwnServer, loadExtraMcpServers, pinCopilotVersion } from "./extraServers.js";

const reservedNames = ["easyeda-pro", "easyeda-chat"];
let dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyeda-extra-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("detectEasyEdaServers", () => {
  it("finds EasyEDA servers in user and project scopes and skips unrelated ones", () => {
    expect(Object.keys(detectEasyEdaServers({
      mcpServers: {
        "easyeda-pro": { command: "cmd", args: ["/c", "npx", "-y", "@vlabsoftware/easyeda-pro-mcp"] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
      },
      projects: {
        "C:/Users/ADMIN": { mcpServers: { "easyeda-copilot": { command: "npx", args: ["-y", "easyeda-copilot-mcp"] } } },
        "D:/other": { mcpServers: { postgres: { command: "pg-mcp" } } }
      }
    }))).toEqual(["easyeda-pro", "easyeda-copilot"]);
  });
});

describe("isOwnServer", () => {
  it("recognizes this package however it is launched", () => {
    expect(isOwnServer({ command: "cmd", args: ["/c", "npx", "-y", "@vlabsoftware/easyeda-pro-mcp"] })).toBe(true);
    expect(isOwnServer({ command: "npx", args: ["-y", "easyeda-pro-mcp"] })).toBe(true);
    expect(isOwnServer({ command: "node", args: [path.resolve("dist", "index.js")] })).toBe(true);
    expect(isOwnServer({ command: "npx", args: ["-y", "easyeda-copilot-mcp"] })).toBe(false);
  });
});

describe("loadExtraMcpServers", () => {
  it("uses EasyEDA servers from Claude Code's config, minus this package and reserved names", () => {
    const home = tempDir();
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: { "easyeda-pro": { command: "npx", args: ["-y", "@vlabsoftware/easyeda-pro-mcp"] } },
      projects: { "C:/Users/ADMIN": { mcpServers: { "easyeda-copilot": { command: "npx", args: ["-y", "easyeda-copilot-mcp"] } } } }
    }));
    const extra = loadExtraMcpServers({ workDir: tempDir(), homeDir: home, reservedNames });
    expect(extra.source).toBe("claude-code");
    expect(extra.servers).toEqual({ "easyeda-copilot": { command: "npx", args: ["-y", `easyeda-copilot-mcp@${COPILOT_VERSION}`] } });
  });

  it("lets mcp-servers.json override detection, still protecting reserved names", () => {
    const workDir = tempDir();
    fs.writeFileSync(path.join(workDir, "mcp-servers.json"), JSON.stringify({
      mcpServers: {
        mine: { command: "node", args: ["my-server.js"] },
        "easyeda-pro": { command: "evil" },
        "bad name!": { command: "x" }
      }
    }));
    const extra = loadExtraMcpServers({ workDir, homeDir: tempDir(), reservedNames });
    expect(extra.source).toBe("file");
    expect(Object.keys(extra.servers)).toEqual(["mine"]);
  });

  it("returns nothing when no config exists", () => {
    expect(loadExtraMcpServers({ workDir: tempDir(), homeDir: tempDir(), reservedNames })).toEqual({ servers: {}, source: "none" });
  });
});

describe("pinCopilotVersion", () => {
  it("pins unversioned easyeda-copilot-mcp to the bundled client version and leaves others alone", () => {
    expect(pinCopilotVersion({ command: "npx", args: ["-y", "easyeda-copilot-mcp"] }).args).toEqual(["-y", `easyeda-copilot-mcp@${COPILOT_VERSION}`]);
    expect(pinCopilotVersion({ command: "npx", args: ["-y", "easyeda-copilot-mcp@1.2.0"] }).args).toEqual(["-y", "easyeda-copilot-mcp@1.2.0"]);
    expect(pinCopilotVersion({ command: "node", args: ["server.js"] }).args).toEqual(["server.js"]);
  });

  it("matches the version of the client vendored into the extension", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("extension/vendor/easyeda-copilot/extension.json"), "utf8"));
    expect(COPILOT_VERSION).toBe(manifest.version);
  });
});
