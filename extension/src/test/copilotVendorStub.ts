// Vitest stand-in for extension/vendor/easyeda-copilot/entry.ts (see vitest.config.ts).
// The real client registers its own EasyEDA WebSocket, which would disturb bridge tests.
export const COPILOT_CLIENT_VERSION = "test";
export const calls: string[] = [];

export function startCopilotClient(): void {
  calls.push("start");
}

export function toggleCopilotClient(): void {
  calls.push("toggle");
}
