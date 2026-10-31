# Vendored EasyEDA Copilot MCP client

This folder contains the EasyEDA-side MCP client of [EasyEDA Copilot](https://github.com/biosshot/easyeda-copilot) by biosshot, version **1.3.2**, under the MIT License (see `LICENSE`).

With this client bundled into the EasyEDA MCP Bridge extension, the [`easyeda-copilot-mcp`](https://www.npmjs.com/package/easyeda-copilot-mcp) server works without installing the separate EasyEDA Copilot extension. That server provides schematic editing, PCB placement, routing and DRC tools. The client connects to the server's broker at `ws://127.0.0.1:8787`.

| Path | Upstream source |
| --- | --- |
| `src/mcp-client.ts`, `src/mcp-command-queue.ts`, `src/mcp-command-timeout.ts`, `src/timeout.ts`, `src/runtime-bootstrap.ts` | `extension/src/` |
| `src/eda/` | `extension/src/eda/` |
| `shared/` | `shared/` (without `package.json`) |
| `extension.json` | `extension/extension.json`, read by the client for its version |
| `entry.ts` | Not upstream: glue that mirrors upstream `extension/src/index.ts` without the Vue interface |

The upstream files are unchanged. To update, copy the same paths from a newer upstream release, then update `COPILOT_VERSION` in `src/chat/extraServers.ts`. The chat host pins `easyeda-copilot-mcp` to that version so the server and this client match.

Build wiring is in `scripts/build-extension.mjs` (`npm run build:extension`):

- `@copilot/shared` is aliased to `./shared`.
- `easyeda-copilot-vendor` is aliased to `./entry.ts`.
- `zod/v4` is aliased to `zod`, so our code and Copilot's code share one zod entry point. Without it the bundle fails to load in EasyEDA, and every menu item does nothing.
- `src/runtime-bootstrap.ts` is injected, as upstream does.

`scripts/build-extension.test.ts` builds the real bundle and loads it in an EasyEDA-like `with(sandbox)` to catch load-time failures.

Like upstream's own build, these files are bundled by esbuild without type checking. They are excluded from `npm run typecheck:extension`, which sees only the declarations in `extension/src/easyeda-copilot-vendor.d.ts`. Runtime dependencies `p-queue`, `jszip` and `zod` come from the root `package.json`.
