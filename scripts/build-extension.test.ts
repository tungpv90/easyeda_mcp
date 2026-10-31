import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error Plain ESM build script without type declarations.
import { buildExtension } from "./build-extension.mjs";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "easyeda-ext-build-"));

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** A stand-in `eda`: every property is callable and every call is recorded. */
function fakeEda(calls: string[]): unknown {
  const make = (name: string): unknown => new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : make(`${name}.${String(key)}`)),
    apply: () => {
      calls.push(name);
      return name.endsWith("getEditorCurrentVersion") ? "3.2.149" : undefined;
    }
  });
  return make("eda");
}

describe("extension bundle", () => {
  it("loads in an EasyEDA-like sandbox and exposes every menu function", async () => {
    const outfile = path.join(outDir, "index.js");
    await buildExtension(outfile);

    const calls: string[] = [];
    const target: Record<string, unknown> = { eda: fakeEda(calls) };
    const isEnum = (key: PropertyKey) => typeof key === "string" && /^E[A-Z]{2,}_/.test(key);
    // EasyEDA runs extensions inside with(sandbox), and provides enums such as ESYS_ToastMessageType as globals.
    const sandbox = new Proxy(target, {
      has: (t, key) => key in t || isEnum(key),
      get: (t, key) => (key in t ? t[key as string] : isEnum(key) ? fakeEda(calls) : undefined),
      set: (t, key, value) => {
        t[key as string] = value;
        return true;
      }
    });
    const context = vm.createContext({ sandbox, console, setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask, structuredClone, AbortController, crypto: globalThis.crypto });

    vm.runInContext(`with (sandbox) { ${fs.readFileSync(outfile, "utf8")}\n; sandbox.__exports = edaEsbuildExportName; }`, context);

    const exports = target.__exports as Record<string, unknown>;
    const manifest = JSON.parse(fs.readFileSync(path.resolve("extension/extension.json"), "utf8"));
    const menuFunctions = new Set<string>();
    for (const menus of Object.values(manifest.headerMenus) as Array<Array<{ menuItems: Array<{ registerFn: string }> }>>) {
      for (const menu of menus) {
        for (const item of menu.menuItems) {
          menuFunctions.add(item.registerFn);
        }
      }
    }
    for (const fn of menuFunctions) {
      expect(typeof exports[fn], `menu function ${fn}`).toBe("function");
    }

    (exports.connect as () => void)();
    await (exports.openChat as () => Promise<void>)();
    expect(calls).toContain("eda.sys_WebSocket.register");
    expect(calls).toContain("eda.sys_IFrame.openIFrame");
  }, 60_000);
});
