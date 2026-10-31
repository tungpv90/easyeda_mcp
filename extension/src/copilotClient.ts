/**
 * Starts the vendored EasyEDA Copilot MCP client (extension/vendor/easyeda-copilot), so the
 * easyeda-copilot-mcp server's schematic editing, placement and routing tools work without
 * the separate EasyEDA Copilot extension. Calls are isolated: a failure here never affects
 * the MCP Bridge itself.
 *
 * The import is static on purpose. A dynamic import() makes esbuild wrap shared modules in
 * lazy initializers, and zod's circular imports then run before they are initialized
 * ("Class is not a constructor"), which breaks the whole extension at load time.
 */
import { startCopilotClient as start, toggleCopilotClient as toggle } from "easyeda-copilot-vendor";

export function startCopilotClient(onError: (error: unknown) => void): void {
  try {
    start();
  } catch (error) {
    onError(error);
  }
}

export function toggleCopilotClient(onError: (error: unknown) => void): void {
  try {
    toggle();
  } catch (error) {
    onError(error);
  }
}
