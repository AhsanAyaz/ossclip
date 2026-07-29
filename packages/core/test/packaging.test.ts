import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The published tarball must carry every file the code reads at RUNTIME
 * (R22 §111).
 *
 * `@ossclip/core@0.1.0` shipped `files: ["README.md", "src"]` and nothing
 * else — but `face.ts` loads the vendored pico cascade from `../assets/
 * facefinder`. In this workspace that resolves through a symlink to the
 * whole package directory, so every local run and every test passed; from
 * npm it was an ENOENT the first time a source needed face detection. The
 * gap is invisible to anything that reads the repo instead of the tarball.
 *
 * So this test reads the SOURCE for the paths it actually loads and asserts
 * each one is inside a `files` entry. A new runtime asset that nobody adds
 * to `files` fails here rather than in a stranger's terminal.
 */
const PKG_ROOT = new URL("..", import.meta.url).pathname;

const filesField = (): string[] =>
  JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).files as string[];

/** Every `new URL("../<path>", import.meta.url)` a source file loads. */
function runtimeAssetPaths(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(
          /new URL\(\s*["'`]\.\.\/([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g,
        )) {
          out.add(m[1]!);
        }
      }
    }
  };
  walk(join(PKG_ROOT, "src"));
  return [...out];
}

describe("published package contents (R22 §111)", () => {
  it("every runtime asset the source loads exists and is packed", () => {
    const files = filesField();
    const assets = runtimeAssetPaths();
    // The regression this guards is real; if the pattern ever finds nothing,
    // it has stopped matching and the test is lying rather than passing.
    expect(assets.length).toBeGreaterThan(0);
    for (const rel of assets) {
      expect(existsSync(join(PKG_ROOT, rel)), `${rel} missing from the package`).toBe(true);
      const top = rel.split("/")[0]!;
      expect(
        files.some((f) => f === top || f === rel || f.startsWith(`${top}/`)),
        `${rel} is loaded at runtime but "${top}" is not in package.json files — ` +
          "it would be missing from the npm tarball",
      ).toBe(true);
    }
  });

  it("the pico cascade specifically — the one that shipped broken", () => {
    expect(existsSync(join(PKG_ROOT, "assets/facefinder"))).toBe(true);
    expect(filesField()).toContain("assets");
  });
});
