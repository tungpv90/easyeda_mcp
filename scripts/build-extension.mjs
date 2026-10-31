import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(repoRoot, "extension", "vendor", "easyeda-copilot");

/** esbuild options for the EasyEDA extension bundle (extension/dist/index.js). */
export function extensionBuildOptions(outfile = path.join(repoRoot, "extension", "dist", "index.js")) {
  return {
    entryPoints: [path.join(repoRoot, "extension", "src", "index.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "edaEsbuildExportName",
    outfile,
    logLevel: "warning",
    alias: {
      "@copilot/shared": path.join(vendorRoot, "shared"),
      "easyeda-copilot-vendor": path.join(vendorRoot, "entry.ts"),
      // One zod entry point for our code and the vendored Copilot code. With both "zod" and
      // "zod/v4", Copilot's dynamic imports make esbuild initialize zod lazily in an order
      // where schemas are built before their classes exist ("Class is not a constructor"),
      // and the whole extension fails to load.
      "zod/v4": "zod"
    },
    // Copilot's runtime shims (timers, crypto.randomUUID, AbortController) for EasyEDA's sandbox.
    inject: [path.join(vendorRoot, "src", "runtime-bootstrap.ts")]
  };
}

export async function buildExtension(outfile) {
  return build(extensionBuildOptions(outfile));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildExtension();
  console.log("Built extension/dist/index.js");
}
