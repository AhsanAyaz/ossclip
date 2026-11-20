import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAW_EXAMPLES, checkDrawnScene } from "@ossclip/core";
import { DRAW_KIT_EXPORTS } from "@ossclip/scenes/draw/reference";
import { typecheckDrawnScene } from "../src/draw/typecheck";

/**
 * The draw prompt's worked examples against the REAL kit (§167). Core's own
 * test checks them with a kit list written in the test, because core cannot
 * import the scenes package; this is where the CLI, which has both, proves
 * the examples import only what the kit exports and type-check against its
 * props. An example that fails here teaches every drawn scene a mistake.
 *
 * Written to the OS temp dir, as draw-typecheck.test.ts does: a scene's
 * workdir has no node_modules, so passing here proves the kit and React
 * resolve from ossclip's own install.
 */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ossclip-draw-examples-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the draw prompt's worked examples", () => {
  it.each(DRAW_EXAMPLES.map((ex, i) => [i + 1, ex.code] as const))(
    "example %i passes the static check with the kit's real exports and type-checks against the kit",
    (n, code) => {
      expect(checkDrawnScene(code, DRAW_KIT_EXPORTS)).toEqual([]);
      const path = join(dir, `example-${n}.tsx`);
      writeFileSync(path, code);
      expect(typecheckDrawnScene(path)).toEqual([]);
    },
    60_000,
  );
});
