import { describe, expect, it } from "vitest";
import { ProductionSchema, ProductionScriptSchema } from "../src/schema";

/**
 * `production.json`'s `script` slot (explainer plan Task 8): the script TEXT a
 * `--script` run was planned from, so the editor's Re-plan works after the
 * file moves (Review Focus 5). Optional and absent without a script, which is
 * what keeps every other run's production.json byte-identical (G6).
 */
const bareProduction = {
  version: 1,
  source: {
    path: "/takes/raw.mp4",
    probe: { duration: 12, width: 1080, height: 1920, fps: 30, hasAudio: true },
  },
  cleanup: "standard",
  render: { width: 1080, height: 1920, fps: 30 },
};

describe("ProductionSchema.script", () => {
  it("parses a production.json with no script, and adds none", () => {
    const parsed = ProductionSchema.parse(bareProduction);
    expect(parsed.script).toBeUndefined();
    expect("script" in parsed).toBe(false);
  });

  it("round-trips the text, its source path and the imported clips", () => {
    const script = {
      text: "🎬 clip: clips/a.mov\n🗣️ hello",
      sourcePath: "/videos/egm/script.md",
      clips: [{ path: "clips/a.mov", src: "clips/0123456789ab.webm", durationSec: 4.6 }],
    };
    const parsed = ProductionSchema.parse(JSON.parse(JSON.stringify({ ...bareProduction, script })));
    expect(parsed.script).toEqual(script);
  });

  it("the text alone is a valid record", () => {
    expect(ProductionScriptSchema.parse({ text: "🎬 A" })).toEqual({ text: "🎬 A" });
  });

  it("retakePass: 1 says the script retake pass ran (§166); its absence is a project planned before it", () => {
    expect(ProductionScriptSchema.parse({ text: "🎬 A", retakePass: 1 })).toEqual({ text: "🎬 A", retakePass: 1 });
    expect("retakePass" in ProductionScriptSchema.parse({ text: "🎬 A" })).toBe(false);
  });

  it("refuses any other retakePass: a value this build does not know is not a pass it can repeat", () => {
    expect(() => ProductionScriptSchema.parse({ text: "🎬 A", retakePass: 2 })).toThrow();
  });

  it("refuses a record with no text, or a clip with no length", () => {
    expect(() => ProductionSchema.parse({ ...bareProduction, script: { sourcePath: "/s.md" } })).toThrow();
    expect(() =>
      ProductionScriptSchema.parse({
        text: "x",
        clips: [{ path: "clips/a.mov", src: "clips/x.webm", durationSec: 0 }],
      }),
    ).toThrow();
  });
});
