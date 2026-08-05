import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfigPatch } from "@ossclip/core";
import { resolveWatermark } from "../src/produce";

/**
 * The opt-in "made with ossclip" credit. The matrix under test is the whole
 * contract: default OFF for everyone (open-source etiquette — a forced
 * watermark reads as a free-tier limitation), config supplies a once-set
 * default, and a TYPED flag always wins — `--no-watermark` must beat a
 * config-on, or the config would be a trap you can't escape per run.
 */
describe("resolveWatermark", () => {
  it("defaults off with no flag and no config", () => {
    expect(resolveWatermark(undefined, undefined)).toBe(false);
  });

  it("the config turns it on when the flag is not typed", () => {
    expect(resolveWatermark(undefined, true)).toBe(true);
    expect(resolveWatermark(undefined, false)).toBe(false);
  });

  it("a typed flag beats the config in both directions", () => {
    expect(resolveWatermark(false, true)).toBe(false); // --no-watermark vs config-on
    expect(resolveWatermark(true, false)).toBe(true); // --watermark vs config-off
    expect(resolveWatermark(true, undefined)).toBe(true);
    expect(resolveWatermark(false, undefined)).toBe(false);
  });

  // config.json is hand-editable and loadConfig doesn't zod-parse it — a
  // malformed value must stay OFF (the safe default for a credit), never be
  // coerced on by truthiness.
  it("a non-boolean config value stays off", () => {
    expect(resolveWatermark(undefined, "yes" as unknown as boolean)).toBe(false);
    expect(resolveWatermark(undefined, 1 as unknown as boolean)).toBe(false);
  });
});

describe("the watermark preference round-trips through config.json", () => {
  it("writes and reads back without touching a real home", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-watermark-"));
    const path = saveConfigPatch({ watermark: true }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ watermark: true });
  });

  it("leaves neighbouring hand-edited keys alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-watermark-"));
    saveConfigPatch({ speaker: "Ahsan" }, dir);
    const path = saveConfigPatch({ watermark: true }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      speaker: "Ahsan",
      watermark: true,
    });
  });
});
