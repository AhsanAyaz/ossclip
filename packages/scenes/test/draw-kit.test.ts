import { describe, expect, it } from "vitest";
import { checkDrawnScene, DRAW_KIT_MODULE } from "@ossclip/core";
import { defaultTheme, ICON_NAMES } from "@ossclip/core/browser";
import * as kit from "../src/draw";
import { DRAW_KIT_EXPORTS, DRAW_KIT_REFERENCE } from "../src/draw";
import { assetFile, requireDrawContext, safeAreaPx, sceneSeconds, type DrawContextValue } from "../src/draw/context";
import { fadeIn, riseIn } from "../src/motion";
import { safeRectFor, LANDSCAPE_FRAME, PORTRAIT_FRAME } from "../src/stage";

// The kit's components and hooks render only inside a Remotion frame, and
// this package deliberately carries no react-dom to stand one up (see
// caption-track.test.ts). So the behaviour the hooks and `Asset` are built
// on is split into pure functions in context.tsx, and those are tested here:
// the hooks are one `useContext` plus these.

describe("fadeIn", () => {
  it("is 0 before its start, 1 from start + durSec, and between on the way", () => {
    expect(fadeIn(0, 1)).toBe(0);
    expect(fadeIn(1, 1)).toBe(0);
    expect(fadeIn(1.15, 1)).toBeCloseTo(0.75, 10); // half way on easeOutQuad
    expect(fadeIn(1.3, 1)).toBe(1);
    expect(fadeIn(9, 1)).toBe(1);
  });

  it("takes its duration from the third argument", () => {
    expect(fadeIn(0.5, 0, 1)).toBeCloseTo(0.75, 10);
    expect(fadeIn(1, 0, 1)).toBe(1);
  });

  it("treats a zero duration as already arrived, never NaN", () => {
    expect(fadeIn(-0.1, 0, 0)).toBe(0);
    expect(fadeIn(0, 0, 0)).toBe(1);
  });
});

describe("riseIn", () => {
  it("is px before its start, exactly 0 from start + durSec, and between on the way", () => {
    expect(riseIn(0, 1)).toBe(26);
    expect(riseIn(1, 1)).toBe(26);
    expect(riseIn(1.175, 1)).toBeCloseTo(26 * 0.25, 10); // half way on easeOutQuad
    expect(riseIn(1.35, 1)).toBe(0);
    expect(riseIn(9, 1)).toBe(0);
  });

  it("takes its duration and distance from the third and fourth arguments", () => {
    expect(riseIn(0, 0, 1, 100)).toBe(100);
    expect(riseIn(0.5, 0, 1, 100)).toBeCloseTo(25, 10);
    expect(riseIn(1, 0, 1, 100)).toBe(0);
  });

  it("treats a zero duration as already arrived, never NaN", () => {
    expect(riseIn(-0.1, 0, 0)).toBe(26);
    expect(riseIn(0, 0, 0)).toBe(0);
  });
});

describe("sceneSeconds", () => {
  it("is the frame over the frame rate", () => {
    expect(sceneSeconds(0, 30)).toBe(0);
    expect(sceneSeconds(45, 30)).toBe(1.5);
    expect(sceneSeconds(60, 60)).toBe(1);
  });
});

describe("safeAreaPx", () => {
  it("is the stage's safe area in whole pixels for portrait and landscape", () => {
    expect(safeAreaPx(PORTRAIT_FRAME)).toEqual({ x: 44, y: 231, width: 863, height: 1266 });
    expect(safeAreaPx(LANDSCAPE_FRAME)).toEqual({ x: 96, y: 65, width: 1728, height: 885 });
  });

  it("rounds inward: inside the fractional safe rect, and within a pixel of each edge", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME, { width: 1000, height: 1000 }, { width: 721, height: 1283 }]) {
      const px = safeAreaPx(frame);
      const r = safeRectFor(frame);
      const exact = { l: r.x * frame.width, t: r.y * frame.height, r: (r.x + r.w) * frame.width, b: (r.y + r.h) * frame.height };
      const edges = { l: px.x, t: px.y, r: px.x + px.width, b: px.y + px.height };
      for (const v of Object.values(px)) expect(Number.isInteger(v)).toBe(true);
      expect(edges.l).toBeGreaterThanOrEqual(exact.l - 1e-6);
      expect(edges.t).toBeGreaterThanOrEqual(exact.t - 1e-6);
      expect(edges.r).toBeLessThanOrEqual(exact.r + 1e-6);
      expect(edges.b).toBeLessThanOrEqual(exact.b + 1e-6);
      expect(edges.l - exact.l).toBeLessThan(1);
      expect(edges.t - exact.t).toBeLessThan(1);
      expect(exact.r - edges.r).toBeLessThan(1);
      expect(exact.b - edges.b).toBeLessThan(1);
    }
  });

  it("keeps an edge that lands on a whole pixel, despite float error", () => {
    // 0.05 × 1920 is 96 only up to float error; a bare ceil would make it 97.
    expect(safeAreaPx(LANDSCAPE_FRAME).x).toBe(96);
  });
});

describe("hooks outside DrawProvider", () => {
  it("throw an error that names DrawProvider and the hook", () => {
    expect(() => requireDrawContext(null, "useTheme")).toThrow(/DrawProvider/);
    expect(() => requireDrawContext(null, "useTheme")).toThrow(/useTheme/);
  });

  it("return the provided value inside one", () => {
    const value: DrawContextValue = { theme: defaultTheme, width: 1080, height: 1920, assets: {} };
    expect(requireDrawContext(value, "useTheme")).toBe(value);
  });
});

describe("assetFile", () => {
  const assets = { logo: "assets/logo.png" };

  it("is the staticFile path for a known name", () => {
    expect(assetFile(assets, "logo")).toBe("assets/logo.png");
  });

  it("is null for an unknown name, so Asset renders nothing instead of throwing", () => {
    expect(assetFile(assets, "missing")).toBeNull();
    expect(() => assetFile(assets, "missing")).not.toThrow();
  });

  it("does not read names off the object's prototype", () => {
    expect(assetFile(assets, "toString")).toBeNull();
    expect(assetFile(assets, "__proto__")).toBeNull();
  });
});

describe("the kit's export surface", () => {
  // DrawProvider is the host's, not the scene's; the version and the two
  // lists describe the kit to the pipeline. Everything else a scene may import.
  const META = ["DrawProvider", "DRAW_KIT_VERSION", "DRAW_KIT_EXPORTS", "DRAW_KIT_REFERENCE"];

  it("exports every name in DRAW_KIT_EXPORTS", () => {
    for (const name of DRAW_KIT_EXPORTS) expect(kit, name).toHaveProperty(name);
  });

  it("exports nothing outside DRAW_KIT_EXPORTS but the host's and pipeline's names", () => {
    const extra = Object.keys(kit).filter((k) => !META.includes(k) && !DRAW_KIT_EXPORTS.includes(k));
    expect(extra).toEqual([]);
  });

  it("keeps the spring-progress helpers out: they take a spring progress, not seconds", () => {
    for (const name of ["pop", "rise", "fade"]) expect(Object.keys(kit)).not.toContain(name);
  });

  it("is version 1", () => {
    expect(kit.DRAW_KIT_VERSION).toBe(1);
  });
});

/** The `interface Theme { … }` field names and types the reference declares. */
function referenceThemeFields(): { name: string; type: string }[] {
  const block = /interface Theme \{([\s\S]*?)\n\}/.exec(DRAW_KIT_REFERENCE)?.[1] ?? "";
  return [...block.matchAll(/^\s*(\w+)\??:\s*(\w+);/gm)].map((m) => ({ name: m[1]!, type: m[2]! }));
}

describe("DRAW_KIT_REFERENCE", () => {
  it("declares every export, each under a comment line", () => {
    const lines = DRAW_KIT_REFERENCE.split("\n");
    for (const name of DRAW_KIT_EXPORTS) {
      const i = lines.findIndex((l) => new RegExp(`^export declare (?:function|const) ${name}\\b`).test(l));
      expect(i, name).toBeGreaterThan(0);
      expect(lines[i - 1], name).toMatch(/^\/\/ \S/);
    }
  });

  it("declares nothing a scene cannot import", () => {
    const declared = [...DRAW_KIT_REFERENCE.matchAll(/^export declare (?:function|const) (\w+)/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...DRAW_KIT_EXPORTS].sort());
  });

  it("lists Theme's colour and font fields under their real names and types", () => {
    const fields = referenceThemeFields();
    for (const want of ["bg", "fg", "accent", "accent2", "muted", "cardBg", "cardBorder", "fontDisplay", "fontMono"]) {
      expect(fields.map((f) => f.name)).toContain(want);
    }
    for (const { name, type } of fields) {
      expect(defaultTheme, name).toHaveProperty(name);
      expect(typeof defaultTheme[name as keyof typeof defaultTheme], name).toBe(type);
    }
  });

  it("lists exactly the icon names Icon draws", () => {
    const union = /type IconName = ([^;]+);/.exec(DRAW_KIT_REFERENCE)?.[1] ?? "";
    const names = [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...ICON_NAMES]);
  });

  it("stays short: it is sent with every draw call", () => {
    expect(DRAW_KIT_REFERENCE.split("\n").length).toBeLessThanOrEqual(150);
  });
});

describe("the kit against the static check", () => {
  // Nothing the kit asks a scene to write may be a name the check rejects
  // (§167) — why useSafeArea is { x, y, width, height } and not
  // left/top/right/bottom. This scene imports every export and reads every
  // safe-area key and every Theme field the reference lists.
  it("passes a scene that imports every export and reads every safe-area key and Theme field", () => {
    const safeKeys = Object.keys(safeAreaPx(PORTRAIT_FRAME));
    const themeReads = referenceThemeFields().map((f) => `theme.${f.name}`);
    const code = [
      `import React from "react";`,
      `import { AbsoluteFill } from "remotion";`,
      `import { ${DRAW_KIT_EXPORTS.join(", ")} } from "${DRAW_KIT_MODULE}";`,
      `export default function Scene() {`,
      `  const theme = useTheme();`,
      `  const { ${safeKeys.join(", ")} } = useSafeArea();`,
      `  const all = [${themeReads.join(", ")}, ${safeKeys.join(", ")}];`,
      `  return <AbsoluteFill><Card border={theme.accent}>{all.length}</Card></AbsoluteFill>;`,
      `}`,
    ].join("\n");
    expect(checkDrawnScene(code, DRAW_KIT_EXPORTS)).toEqual([]);
  });
});
