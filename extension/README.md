# EasyEDA MCP Bridge Extension

This extension connects EasyEDA Pro to the local MCP bridge at:

```text
ws://127.0.0.1:8765
```

It is required for live editor access. Without it, the MCP server can start, but tools cannot inspect the open EasyEDA Pro session.

This extension is part of an independent open-source project for PCB enthusiasts and professionals. It is not affiliated with, endorsed by, or maintained by EasyEDA or its company.

## Build

Run from the repository root:

```bash
npm run setup:local
```

This creates:

```text
extension/dist/index.js
```

The manifest is:

```text
extension/extension.json
```

## Install

In EasyEDA Pro:

1. import or load the packaged extension
2. enable external interaction permission
3. open a schematic or PCB
4. use `MCP Bridge -> Reconnect` if it does not connect automatically
5. use `MCP Bridge -> Run Diagnostics` if you need extension-side status

## EasyEDA Copilot Tools

The extension bundles the EasyEDA-side client of [EasyEDA Copilot](https://github.com/biosshot/easyeda-copilot) 1.3.2 (MIT, see `THIRD_PARTY_NOTICES.md` and `vendor/easyeda-copilot/`). With it, the `easyeda-copilot-mcp` server's schematic editing, PCB placement and routing tools work without installing the EasyEDA Copilot extension. The client connects to `ws://127.0.0.1:8787` whenever that server runs. Use `MCP Bridge -> Copilot Tools: Pause/Resume` to turn it off and on. If the EasyEDA Copilot extension is also installed, disable it.

## Claude Chat Panel

`MCP Bridge -> Claude Chat` opens `iframe/chat.html`, a chat panel that talks to the local chat host started with `npx -y @vlabsoftware/easyeda-pro-mcp chat` (default `ws://127.0.0.1:8766/chat`). Answers come from the Claude Code CLI signed in on the same computer. See the [chat guide](https://vlabsoft.org/easyeda_mcp/claude-chat).

## Verify

From your MCP client, run:

```text
Run easyeda_doctor.
```

Healthy output should show:

- extension connected
- bridge protocol compatible
- active document available

## PCB Design Rules (DRC)

Supports native PCB rule reads, edit previews, and confirmed updates (`CONFIRM editDrcRules <editId>`). See the [DRC Rule Editing guide](https://vlabsoft.org/easyeda_mcp/drc-rules).

## Notes

- This project is live-extension only; it does not parse `.epro` archives.
- Read, navigation, and export tools run directly.
- Project-changing actions go through `easyeda_confirmed_action`.
- Connection defaults are defined in `extension/src/bridgeConfig.ts`.
