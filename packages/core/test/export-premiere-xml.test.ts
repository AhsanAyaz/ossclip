import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildPremiereXmlMarkers } from "../src/export-premiere-xml";
import type { Production } from "../src/schema";

/**
 * Premiere marker export (§142): the field test killed the doc's premise that
 * Premiere reads FCPXML — it does not ("File format not supported"); it reads
 * the LEGACY FCP7 interchange format, xmeml. This exporter emits an xmeml v4
 * sequence whose SEQUENCE-level markers carry the cut list; Premiere shows
 * those on the timeline ruler after File → Import of the .xml.
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
      { srcIn: 10.5, srcOut: 60, kind: "keep" },
    ],
    render: { width: 1080, height: 1920, fps: 30 },
    ...overrides,
  };
}

function parseXml(xml: string): Document {
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

describe("buildPremiereXmlMarkers", () => {
  it("is xmeml version 4 with one sequence-level marker per remove segment", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    expect(doc.querySelector("xmeml")!.getAttribute("version")).toBe("4");
    const markers = Array.from(doc.querySelectorAll("sequence > marker"));
    expect(markers).toHaveLength(2);
  });

  it("marker in/out are frames at the source rate; out -1 marks a point, not a span", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const markers = Array.from(doc.querySelectorAll("sequence > marker"));
    // 0s and 10s at 60fps.
    expect(markers[0]!.querySelector("in")!.textContent).toBe("0");
    expect(markers[1]!.querySelector("in")!.textContent).toBe("600");
    expect(markers[0]!.querySelector("out")!.textContent).toBe("-1");
  });

  it("name carries the report vocabulary (ASCII hyphen — xmeml consumers vary)", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const names = Array.from(doc.querySelectorAll("sequence > marker > name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["silence -1.77s (conf 0.95)", "filler -0.50s (conf 0.80)"]);
  });

  it("the sequence rate is the source's, ntsc FALSE for an integer rate", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const rate = doc.querySelector("sequence > rate")!;
    expect(rate.querySelector("timebase")!.textContent).toBe("60");
    expect(rate.querySelector("ntsc")!.textContent).toBe("FALSE");
  });

  it("NTSC source: timebase rounds up and ntsc flips TRUE — 29.97 is '30 TRUE' in xmeml", () => {
    const p = production();
    p.source.probe.fps = 30000 / 1001;
    const doc = parseXml(buildPremiereXmlMarkers(p));
    const rate = doc.querySelector("sequence > rate")!;
    expect(rate.querySelector("timebase")!.textContent).toBe("30");
    expect(rate.querySelector("ntsc")!.textContent).toBe("TRUE");
  });

  it("the SEQUENCE declares the source's own frame size — without it Premiere defaults to 720x480 DV and shows the clip cropped (field fix, Kinza 2026-08-12)", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const fmt = doc.querySelector("sequence > media > video > format > samplecharacteristics")!;
    expect(fmt.querySelector("width")!.textContent).toBe("2560");
    expect(fmt.querySelector("height")!.textContent).toBe("1440");
    expect(fmt.querySelector("pixelaspectratio")!.textContent).toBe("square");
    expect(fmt.querySelector("anamorphic")!.textContent).toBe("FALSE");
  });

  it("references the source clip via pathurl so the timeline arrives with media to relink", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const pathurl = doc.querySelector("clipitem file pathurl")!.textContent!;
    expect(pathurl.startsWith("file://")).toBe(true);
    expect(pathurl).toContain("demo.mp4");
  });

  it("a path with XML-hostile characters survives a real parse", () => {
    const p = production();
    p.source.path = "/takes/A & B's <take>.mp4";
    const doc = parseXml(buildPremiereXmlMarkers(p));
    expect(doc.querySelector("clipitem file name")!.textContent).toBe("A & B's <take>.mp4");
  });

  it("empty cutlist is a valid sequence with zero markers", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production({ cutlist: [] })));
    expect(doc.querySelectorAll("marker")).toHaveLength(0);
    expect(doc.querySelector("sequence")).not.toBeNull();
  });
});
