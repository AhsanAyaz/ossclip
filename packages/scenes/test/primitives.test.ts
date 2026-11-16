import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ICON_NAMES } from "@ossclip/core/browser";
import { ICON_PATHS } from "../src/primitives/icon-paths";

describe("ICON_PATHS", () => {
  // The Record type already refuses a missing key at compile time; this pins
  // the runtime side, where an empty array would render a blank square in a
  // card that asked for an icon.
  it("draws every icon name core's schemas accept, and nothing else", () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
    for (const name of ICON_NAMES) {
      if (name === "none") expect(ICON_PATHS[name]).toEqual([]);
      else expect(ICON_PATHS[name].length, name).toBeGreaterThan(0);
    }
  });

  it("keeps every path on the 24×24 grid it is drawn in", () => {
    for (const [name, paths] of Object.entries(ICON_PATHS)) {
      for (const d of paths) {
        expect(d, name).toMatch(/^M[\d\s.,MLHVCSAZmlhvcsaz-]+$/);
        // Absolute coordinates only: every number after an uppercase command
        // stays inside 0..24. Relative segments are checked by eye in stills.
        const absNums = [...d.matchAll(/[ML]([\d.]+)[ ,]?([\d.]+)/g)].flatMap((m) => [
          Number(m[1]),
          Number(m[2]),
        ]);
        for (const n of absNums) expect(n, `${name}: ${d}`).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("the primitives' colours", () => {
  // Every colour comes from a theme role, so a look (or a user's config
  // accent) recolours the pattern scenes whole. The one exemption is the
  // shared shadow, which is black at an alpha by nature (shadow.ts).
  it("carry no colour literal outside shadow.ts", () => {
    const dir = fileURLToPath(new URL("../src/primitives", import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "shadow.ts") continue;
      const src = readFileSync(`${dir}/${name}`, "utf8");
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
