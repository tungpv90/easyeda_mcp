// Surface of extension/vendor/easyeda-copilot/entry.ts. The build aliases this module name
// to that file; declaring it here keeps the vendored sources out of our type checking.
declare module "easyeda-copilot-vendor" {
  export const COPILOT_CLIENT_VERSION: string;
  export function startCopilotClient(): void;
  export function toggleCopilotClient(): void;
}
