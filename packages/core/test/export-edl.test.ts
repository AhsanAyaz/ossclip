import { describe, expect, it } from "vitest";
import { buildResolveMarkerEdl, framesToTimecode } from "../src/export-edl";
import type { Production } from "../src/schema";

/**
 * Resolve marker EDL export (field test 2026-08-12, §142): Resolve's FCPXML
 * import silently DROPS clip markers — the timeline arrived, the 127 markers
 * did not — and its dedicated marker path is `Timeline → Import → Timeline
 * Markers from EDL`, whose format is Resolve's own marker-EDL:
 * ` |C:ResolveColor<name> |M:<label> |D:<frames>` continuation lines. That
 * format also carries COLOURS, which FCPXML markers cannot.
 */

function production(overrides: Partial<Production> = {}): Production {
  return {
    version: 1,
    source: {
      path: "/takes/demo.mp4",
      probe: { duration: 60, width: 2560, height: 1440, fps: 60, hasAudio: true },
    },
    cleanup: "aggressive",
    cutlist: [
      { srcIn: 0, srcOut: 1.77, kind: "remove", reason: "silence", confidence: 0.95 },
      { srcIn: 1.77, srcOut: 10, kind: "keep" },
      { srcIn: 10, srcOut: 10.5, kind: "remove", reason: "filler", confidence: 0.8 },
      { srcIn: 10.5, srcOut: 20, kind: "keep" },
      { srcIn: 20, srcOut: 24, kind: "remove", reason: "retake", confidence: 0.9 },
      { srcIn: 24, srcOut: 60, kind: "keep" },
    ],
    render: { width: 1080, height: 1920, fps: 30 },
    ...overrides,
  };
}

describe("framesToTimecode", () => {
  it("formats hh:mm:ss:ff at the given integer rate", () => {
    expect(framesToTimecode(0, 60)).toBe("00:00:00:00");
    expect(framesToTimecode(59, 60)).toBe("00:00:00:59");
    expect(framesToTimecode(60, 60)).toBe("00:00:01:00");
    expect(framesToTimecode(3600 * 60 + 61, 60)).toBe("01:00:01:01");
  });

  it("30fps: one hour is exactly 108000 frames", () => {
    expect(framesToTimecode(108000, 30)).toBe("01:00:00:00");
  });
});

describe("buildResolveMarkerEdl", () => {
  it("one event per remove segment, source time in record TC, one-frame duration", () => {
    const edl = buildResolveMarkerEdl(production());
    const events = edl.split("\n").filter((l) => /^\d{3} /.test(l));
    expect(events).toHaveLength(3);
    // 1.77s → nothing (that segment starts at 0): first marker at 0.
    expect(events[0]).toContain("00:00:00:00 00:00:00:01 00:00:00:00 00:00:00:01");
    // 10s at 60fps = frame 600.
    expect(events[1]).toContain("00:00:10:00 00:00:10:01 00:00:10:00 00:00:10:01");
  });

  it("carries the report vocabulary in |M: and maps reason to a Resolve colour in |C:", () => {
    const edl = buildResolveMarkerEdl(production());
    expect(edl).toContain("|C:ResolveColorBlue |M:silence -1.77s (conf 0.95) |D:1");
    expect(edl).toContain("|C:ResolveColorYellow |M:filler -0.50s (conf 0.80) |D:1");
    expect(edl).toContain("|C:ResolveColorRed |M:retake -4.00s (conf 0.90) |D:1");
  });

  it("ASCII only in the label — the true minus sign does not survive every EDL parser", () => {
    expect(buildResolveMarkerEdl(production())).not.toContain("−");
  });

  it("a pipe in a hypothetical label cannot break the field syntax", () => {
    const p = production();
    p.cutlist = [
      { srcIn: 1, srcOut: 2, kind: "remove", reason: "user", confidence: 1 },
    ];
    // "user" maps to green; the label itself is generated, but guard anyway.
    const edl = buildResolveMarkerEdl(p);
    const metaLine = edl.split("\n").find((l) => l.includes("|M:"))!;
    expect(metaLine.match(/\|/g)!.length).toBe(3); // exactly |C:, |M:, |D:
  });

  it("starts with the CMX header and non-drop FCM", () => {
    const edl = buildResolveMarkerEdl(production());
    const lines = edl.split("\n");
    expect(lines[0]).toBe("TITLE: demo.mp4 — ossclip markers");
    expect(lines[1]).toBe("FCM: NON-DROP FRAME");
  });

  it("empty cutlist exports a header-only EDL", () => {
    const edl = buildResolveMarkerEdl(production({ cutlist: [] }));
    expect(edl.split("\n").filter((l) => /^\d{3} /.test(l))).toHaveLength(0);
    expect(edl).toContain("TITLE:");
  });
});
