import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 0.1.42 shipped uninstallable-at-runtime: @ossclip/scenes pinned
// `@remotion/gif` to exactly 4.0.499 (which hard-depends on remotion@4.0.499),
// while @ossclip/renderer asked for `remotion ^4.0.0`. A fresh `npm i -g`
// resolved the caret to the newest 4.0.x, nested a second copy under
// @remotion/gif, and Remotion's own guard threw "Multiple versions of Remotion
// detected" on the first import. The workspace lockfile held everything at one
// version, so no test saw it. Every Remotion package must name the same exact
// version, peerDependencies included: npm 7+ installs peers, and scenes' peer
// `remotion ^4.0.0` alone was enough to hoist 4.0.541 over a pinned tree.
const PACKAGES = [
  "apps/cli/package.json",
  "apps/editor/package.json",
  "packages/core/package.json",
  "packages/renderer/package.json",
  "packages/scenes/package.json",
];

const isRemotion = (name: string) => name === "remotion" || name.startsWith("@remotion/");

function remotionDeps(): Array<{ file: string; name: string; range: string }> {
  const out: Array<{ file: string; name: string; range: string }> = [];
  for (const file of PACKAGES) {
    const path = fileURLToPath(new URL(`../../../${file}`, import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (isRemotion(name)) out.push({ file, name, range });
      }
    }
  }
  return out;
}

describe("Remotion versions", () => {
  it("every installed Remotion package is pinned to an exact version", () => {
    const loose = remotionDeps().filter((d) => !/^\d+\.\d+\.\d+$/.test(d.range));
    expect(loose).toEqual([]);
  });

  it("all Remotion packages share one version", () => {
    const versions = new Set(remotionDeps().map((d) => d.range));
    expect([...versions]).toHaveLength(1);
  });
});
