import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "easyeda-copilot-vendor": fileURLToPath(new URL("./extension/src/test/copilotVendorStub.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "extension/src/**/*.test.ts", "scripts/**/*.test.ts"]
  }
});
