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

  it("markers are SPANS: in/out are the cut's own frames — the field reversed the point-marker choice (§142 round 2)", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const markers = Array.from(doc.querySelectorAll("sequence > marker"));
    // 0→1.77s and 10→10.5s at 60fps.
    expect(markers[0]!.querySelector("in")!.textContent).toBe("0");
    expect(markers[0]!.querySelector("out")!.textContent).toBe("106");
    expect(markers[1]!.querySelector("in")!.textContent).toBe("600");
    expect(markers[1]!.querySelector("out")!.textContent).toBe("630");
  });

  it("detected-but-kept pauses export at BOTH marker levels (§142 round 2)", () => {
    const p = production();
    p.analysis = {
      silences: [],
      gaps: [],
      breaths: [],
      fillers: [],
      cuttable: [{ start: 20, end: 20.4 }],
    } as NonNullable<Production["analysis"]>;
    const doc = parseXml(buildPremiereXmlMarkers(p));
    const seqNames = Array.from(doc.querySelectorAll("sequence > marker > name")).map(
      (n) => n.textContent,
    );
    const clipNames = Array.from(doc.querySelectorAll("clipitem > marker > name")).map(
      (n) => n.textContent,
    );
    expect(seqNames).toContain("pause 0.40s (kept)");
    expect(clipNames).toContain("pause 0.40s (kept)");
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

  it("markers ALSO live on the clipitem — clip markers are anchored to media time, so they survive the editor's own ripple deletes (Kinza's workflow, §142)", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const clipMarkers = Array.from(doc.querySelectorAll("clipitem > marker"));
    expect(clipMarkers).toHaveLength(2);
    // Same media-time frames as the sequence markers: the clip's in is 0.
    expect(clipMarkers[1]!.querySelector("in")!.textContent).toBe("600");
    expect(clipMarkers[1]!.querySelector("name")!.textContent).toBe("filler -0.50s (conf 0.80)");
  });

  it("the sequence has an AUDIO track linked to the same file — without it Premiere imports a silent sequence (field fix 2, Kinza 2026-08-12)", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production()));
    const audioClip = doc.querySelector("sequence > media > audio > track > clipitem")!;
    expect(audioClip).not.toBeNull();
    // The audio clipitem references the SAME file by id, not a copy — that
    // is what makes Premiere link A to V instead of importing two clips.
    expect(audioClip.querySelector("file")!.getAttribute("id")).toBe(
      doc.querySelector("video clipitem file")!.getAttribute("id"),
    );
    expect(audioClip.querySelector("sourcetrack mediatype")!.textContent).toBe("audio");
    // Explicit link elements tie the pair together for Premiere.
    const links = Array.from(doc.querySelectorAll("sequence link"));
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  it("a source with no audio stream emits no audio track — a silent source must not fabricate one", () => {
    const p = production();
    p.source.probe.hasAudio = false;
    const doc = parseXml(buildPremiereXmlMarkers(p));
    expect(doc.querySelector("sequence > media > audio > track > clipitem")).toBeNull();
    // …and the video clipitem must not link to an audio clipitem that
    // doesn't exist — a dangling linkclipref is undefined importer behavior.
    expect(doc.querySelector("link")).toBeNull();
  });

  it("empty cutlist is a valid sequence with zero markers", () => {
    const doc = parseXml(buildPremiereXmlMarkers(production({ cutlist: [] })));
    expect(doc.querySelectorAll("marker")).toHaveLength(0);
    expect(doc.querySelector("sequence")).not.toBeNull();
  });
});
