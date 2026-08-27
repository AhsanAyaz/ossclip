import { describe, expect, it, vi } from "vitest";
import { resolveResolution } from "../src/produce";

/**
 * `--resolution` × config `"resolution"` (2026-08-27) — `resolveWatermark`'s
 * precedence verbatim: a TYPED flag always wins, and only then does the
 * config supply the default. The config side is zod-parsed rather than
 * trusted, because `loadConfig` hands back whatever the hand-editable JSON
 * said and a typo'd `"4k"` must not reach `Number()` (CLAUDE.md).
 */
describe("resolveResolution", () => {
  it("no flag, no config → 1080, today's behaviour", () => {
    expect(resolveResolution(undefined, undefined)).toBe("1080");
  });

  it("the config supplies the default when no flag is typed", () => {
    expect(resolveResolution(undefined, "auto")).toBe("auto");
  });

  it("a typed flag beats the config", () => {
    expect(resolveResolution("1080", "auto")).toBe("1080");
    expect(resolveResolution("2160", "1080")).toBe("2160");
  });

  it("a malformed config value earns ONE warning and the 1080 default, never a coercion", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(resolveResolution(undefined, "4k")).toBe("1080");
      expect(resolveResolution(undefined, 2160 as unknown as string)).toBe("1080");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain("resolution");
    } finally {
      warn.mockRestore();
    }
  });
});
