import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  buildFcpxmlMarkers,
  fpsToFrameDuration,
  quantizeToFrame,
} from "../src/export-fcpxml";
import type { Production } from "../src/schema";

/**
 * FCPXML marker export (next-directions §2, approved design
 * docs/superpowers/specs/2026-08-12-analyse-fcpxml-export-design.md): the
 * PURE half of `ossclip analyse` — Production in, FCPXML 1.10 string out.
 * Everything here parses the output with a real XML parser (jsdom): asserting
 * on substrings alone would happily bless a document Resolve refuses.
 */

function production(overrides: Partial<Production> = {}): Production {
  return {
    version: 1,
    source: {
      path: "/takes/demo.mp4",
      probe: { duration: 60, width: 1080, height: 1920, fps: 30, hasAudio: true },
    },
    cleanup: "standard",
    cutlist: [
      { srcIn: 0, srcOut: 1.77, kind: "remove", reason: "silence", confidence: 0.95 },
      { srcIn: 1.77, srcOut: 10, kind: "keep" },
      { srcIn: 10, srcOut: 10.5, kind: "remove", reason: "filler", confidence: 0.8 },
      { srcIn: 10.5, srcOut: 60, kind: "keep" },
    ],
    render: { width: 1080, height: 1920, fps: 30 },
    ...overrides,
  };
}

function parseXml(xml: string): Document {
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  // jsdom surfaces XML parse errors as a parsererror element, not a throw.
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

describe("fpsToFrameDuration", () => {
  it("integer rates are 1/fps", () => {
    expect(fpsToFrameDuration(30)).toEqual({ num: 1, den: 30 });
    expect(fpsToFrameDuration(25)).toEqual({ num: 1, den: 25 });
  });

  it("NTSC rates map to their exact rationals — 1/29.97 has no integer form", () => {
    expect(fpsToFrameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(fpsToFrameDuration(23.976)).toEqual({ num: 1001, den: 24000 });
    expect(fpsToFrameDuration(59.94)).toEqual({ num: 1001, den: 60000 });
  });

  it("an ffprobe float that is nearly NTSC still maps — probe reports 29.970029…", () => {
    expect(fpsToFrameDuration(30000 / 1001)).toEqual({ num: 1001, den: 30000 });
  });
});

describe("quantizeToFrame", () => {
  it("snaps a second value to the nearest frame boundary as an FCPXML rational", () => {
    // 1.77s at 30fps = frame 53.1 → frame 53 → "53/30s"
    expect(quantizeToFrame(1.77, { num: 1, den: 30 })).toBe("53/30s");
  });

  it("zero stays zero", () => {
    expect(quantizeToFrame(0, { num: 1, den: 30 })).toBe("0/30s");
  });

  it("NTSC: numerator counts frames scaled by the rate's own numerator", () => {
    // 1s at 29.97fps ≈ frame 29.97 → frame 30 → 30 * 1001/30000
    expect(quantizeToFrame(1, { num: 1001, den: 30000 })).toBe("30030/30000s");
  });
});

describe("buildFcpxmlMarkers", () => {
  it("emits one marker per remove segment, none for keeps, at frame-quantized source time", () => {
    const doc = parseXml(buildFcpxmlMarkers(production()));
    // Array.from, not spread: tsconfig's lib has no dom.iterable, and the
    // DOM lib types a bare "marker" selector as the SVG element anyway.
    const markers = Array.from(doc.querySelectorAll("marker"));
    expect(markers).toHaveLength(2);
    // 0s and 10s at 30fps.
    expect(markers[0]!.getAttribute("start")).toBe("0/30s");
    expect(markers[1]!.getAttribute("start")).toBe("300/30s");
  });

  it("marker names carry the report.txt vocabulary: reason, duration, confidence", () => {
    const doc = parseXml(buildFcpxmlMarkers(production()));
    const names = Array.from(doc.querySelectorAll("marker")).map((m) => m.getAttribute("value"));
    expect(names[0]).toBe("silence −1.77s (conf 0.95)");
    expect(names[1]).toBe("filler −0.50s (conf 0.80)");
  });

  it("the asset references the ORIGINAL source as a file URL", () => {
    const doc = parseXml(buildFcpxmlMarkers(production()));
    const rep = doc.querySelector("media-rep");
    expect(rep?.getAttribute("src")).toBe("file:///takes/demo.mp4");
    expect(rep?.getAttribute("kind")).toBe("original-media");
  });

  it("a path needing XML/URL escaping survives a real parse round-trip", () => {
    const p = production();
    p.source.path = "/takes/A & B's <take> #1.mp4";
    const doc = parseXml(buildFcpxmlMarkers(p));
    // Parsed DOM gives back the decoded XML text; the URL keeps % encoding.
    const src = doc.querySelector("media-rep")!.getAttribute("src")!;
    expect(src.startsWith("file:///takes/")).toBe(true);
    expect(src).not.toContain("&B"); // raw ampersand would have broken the parse
    expect(doc.querySelector("asset")!.getAttribute("name")).toBe("A & B's <take> #1.mp4");
  });

  it("an empty cutlist is a valid document with zero markers — a clean take exports clean", () => {
    const doc = parseXml(buildFcpxmlMarkers(production({ cutlist: [] })));
    expect(doc.querySelectorAll("marker")).toHaveLength(0);
    expect(doc.querySelector("asset-clip")).not.toBeNull();
  });

  it("declares fcpxml 1.10 with the sequence built on the source's own format", () => {
    const doc = parseXml(buildFcpxmlMarkers(production()));
    expect(doc.querySelector("fcpxml")!.getAttribute("version")).toBe("1.10");
    const format = doc.querySelector("format")!;
    expect(format.getAttribute("frameDuration")).toBe("1/30s");
    expect(format.getAttribute("width")).toBe("1080");
    expect(format.getAttribute("height")).toBe("1920");
    // Sequence and clip durations are whole frames of the SOURCE duration.
    expect(doc.querySelector("asset-clip")!.getAttribute("duration")).toBe("1800/30s");
  });

  it("marker duration is exactly one frame", () => {
    const doc = parseXml(buildFcpxmlMarkers(production()));
    expect(doc.querySelector("marker")!.getAttribute("duration")).toBe("1/30s");
  });
});
