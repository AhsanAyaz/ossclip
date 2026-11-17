import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildFcpxmlKit, kitTimelineFrames, type KitTimelineInput } from "../src/export-fcpxml-kit";

/**
 * The kit's timeline (phase 3, design 3.3): track 1 is the cut source, one
 * asset-clip per kept span; each scene clip rides on lane 1, attached to the
 * span it starts in. The numbers are the Resolve 21 spike's (2026-11-16),
 * the one shape known to import. Every document is parsed with a real XML
 * parser, as in export-fcpxml.test.ts.
 */

function parseXml(xml: string): Document {
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  // jsdom surfaces XML parse errors as a parsererror element, not a throw.
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

const STEPS = {
  url: "file:///C:/Users/x/Videos/EGM/steps.mov",
  name: "steps",
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 4.5667,
  hasAudio: true,
};

function spike(overrides: Partial<KitTimelineInput> = {}): KitTimelineInput {
  return {
    name: "spike",
    sequence: { width: 1920, height: 1080, fps: 60 },
    source: {
      url: "file:///C:/Users/x/Videos/take.mp4",
      name: "source",
      fps: 60,
      width: 1920,
      height: 1080,
      durationSec: 47899 / 60,
      hasAudio: true,
    },
    spans: [
      { srcIn: 10, srcOut: 16, outIn: 0, outOut: 6 },
      { srcIn: 30, srcOut: 33, outIn: 6, outOut: 9 },
      { srcIn: 60, srcOut: 66, outIn: 9, outOut: 15 },
    ],
    clips: [
      { ...STEPS, name: "steps A", startSec: 0.5, lengthSec: 4.5667 },
      { ...STEPS, name: "steps B", startSec: 5.5, lengthSec: 4.5667 },
    ],
    ...overrides,
  };
}

describe("kitTimelineFrames (the spike's numbers)", () => {
  it("spans: contiguous offsets, source starts, lengths", () => {
    const f = kitTimelineFrames(spike());
    expect(f.frameDuration).toEqual({ num: 1, den: 60 });
    expect(f.spans).toEqual([
      { offset: 0, start: 600, duration: 360 },
      { offset: 360, start: 1800, duration: 180 },
      { offset: 540, start: 3600, duration: 360 },
    ]);
    expect(f.durationFrames).toBe(900);
  });

  it("clips: both attached to span 0, the second running across two cut points (Review Focus 2)", () => {
    const f = kitTimelineFrames(spike());
    expect(f.clips).toEqual([
      { clip: 0, span: 0, offset: 630, duration: 274 },
      { clip: 1, span: 0, offset: 930, duration: 274 },
    ]);
  });

  it("a clip starting in a later span attaches there, offset in that span's source time", () => {
    const f = kitTimelineFrames(spike({ clips: [{ ...STEPS, startSec: 7, lengthSec: 4.5667 }] }));
    expect(f.clips).toEqual([{ clip: 0, span: 1, offset: 1800 + (420 - 360), duration: 274 }]);
  });

  it("a clip starting exactly on a cut belongs to the span after it", () => {
    const f = kitTimelineFrames(spike({ clips: [{ ...STEPS, startSec: 6, lengthSec: 1 }] }));
    expect(f.clips[0]).toMatchObject({ span: 1, offset: 1800 });
  });

  it("a clip starting at or after the end attaches to the last span", () => {
    const f = kitTimelineFrames(spike({ clips: [{ ...STEPS, startSec: 15, lengthSec: 1 }] }));
    expect(f.clips[0]).toEqual({ clip: 0, span: 2, offset: 3600 + (900 - 540), duration: 60 });
  });

  it("a clip that starts before the first span attaches to the first span", () => {
    const input = spike({
      spans: [{ srcIn: 10, srcOut: 16, outIn: 1, outOut: 7 }],
      clips: [{ ...STEPS, startSec: 0.5, lengthSec: 1 }],
    });
    expect(kitTimelineFrames(input).clips[0]).toMatchObject({ span: 0, offset: 600 + (30 - 60) });
  });

  it("a clip is never shorter than one frame", () => {
    const f = kitTimelineFrames(spike({ clips: [{ ...STEPS, startSec: 1, lengthSec: 0.001 }] }));
    expect(f.clips[0]!.duration).toBe(1);
  });

  it("span edges come from boundaries, so rounded spans never gap or overlap", () => {
    // 0.01 s spans at 60 fps: each boundary rounds on its own.
    const spans = [0, 1, 2, 3].map((i) => ({
      srcIn: 100 + i * 0.5,
      srcOut: 100 + i * 0.5 + 0.0249,
      outIn: i * 0.0249,
      outOut: (i + 1) * 0.0249,
    }));
    const f = kitTimelineFrames(spike({ spans, clips: [] }));
    let at = 0;
    for (const s of f.spans) {
      expect(s.offset).toBe(at);
      at += s.duration;
    }
    expect(at).toBe(Math.round(4 * 0.0249 * 60));
    expect(f.durationFrames).toBe(at);
  });

  it("a span that rounds to zero frames is dropped", () => {
    const f = kitTimelineFrames(
      spike({
        spans: [
          { srcIn: 10, srcOut: 16, outIn: 0, outOut: 6 },
          { srcIn: 20, srcOut: 20.002, outIn: 6, outOut: 6.002 },
          { srcIn: 30, srcOut: 33, outIn: 6.002, outOut: 9.002 },
        ],
        clips: [],
      }),
    );
    expect(f.spans).toEqual([
      { offset: 0, start: 600, duration: 360 },
      { offset: 360, start: 1800, duration: 180 },
    ]);
  });

  it("NTSC 59.94: every sequence time is in 1001/60000 s frames", () => {
    const fps = 60000 / 1001;
    const f = kitTimelineFrames(
      spike({
        sequence: { width: 1920, height: 1080, fps },
        source: { ...spike().source, fps },
      }),
    );
    expect(f.frameDuration).toEqual({ num: 1001, den: 60000 });
    // 6 s at 59.94 = 359.64 frames → 360; 10 s → 599.4 → 599.
    expect(f.spans[0]).toEqual({ offset: 0, start: 599, duration: 360 });
    expect(f.spans[1]!.offset).toBe(360);
  });

  it("a timeline with no kept spans is refused, not written empty", () => {
    expect(() => kitTimelineFrames(spike({ spans: [] }))).toThrow(/no kept span/);
  });
});

describe("buildFcpxmlKit", () => {
  it("is the spike's document: three spine clips, two lane clips on the first, two assets", () => {
    const doc = parseXml(buildFcpxmlKit(spike()));
    expect(doc.querySelector("fcpxml")!.getAttribute("version")).toBe("1.10");

    const spine = Array.from(doc.querySelectorAll("spine > asset-clip"));
    expect(spine).toHaveLength(3);
    expect(spine.map((c) => c.getAttribute("offset"))).toEqual(["0/60s", "360/60s", "540/60s"]);
    expect(spine.map((c) => c.getAttribute("start"))).toEqual(["600/60s", "1800/60s", "3600/60s"]);
    expect(spine.map((c) => c.getAttribute("duration"))).toEqual(["360/60s", "180/60s", "360/60s"]);
    for (const c of spine) {
      expect(c.getAttribute("tcFormat")).toBe("NDF");
      expect(c.getAttribute("format")).toBe("r1");
    }

    const lane = Array.from(spine[0]!.querySelectorAll("asset-clip"));
    expect(lane).toHaveLength(2);
    expect(lane.map((c) => c.getAttribute("lane"))).toEqual(["1", "1"]);
    expect(lane.map((c) => c.getAttribute("offset"))).toEqual(["630/60s", "930/60s"]);
    expect(lane.map((c) => c.getAttribute("duration"))).toEqual(["274/60s", "274/60s"]);
    expect(lane.map((c) => c.getAttribute("name"))).toEqual(["steps A", "steps B"]);
    expect(spine[1]!.querySelectorAll("asset-clip")).toHaveLength(0);

    // One asset per distinct file: the clip placed twice is ONE asset.
    const assets = Array.from(doc.querySelectorAll("asset"));
    expect(assets).toHaveLength(2);
    expect(lane[0]!.getAttribute("ref")).toBe(lane[1]!.getAttribute("ref"));
    const steps = assets.find((a) => a.getAttribute("id") === lane[0]!.getAttribute("ref"))!;
    // The asset's own length is in its OWN frames; the lane clip's in the sequence's.
    expect(steps.getAttribute("duration")).toBe("137/30s");
    expect(steps.getAttribute("hasAudio")).toBe("1");
    expect(steps.getAttribute("audioRate")).toBe("48000");

    for (const rep of Array.from(doc.querySelectorAll("media-rep"))) {
      expect(rep.getAttribute("kind")).toBe("original-media");
      expect(rep.getAttribute("src")!.startsWith("file://")).toBe(true);
    }
  });

  it("formats: one per distinct rate and size, named for integer rates", () => {
    const doc = parseXml(buildFcpxmlKit(spike()));
    const formats = Array.from(doc.querySelectorAll("format"));
    expect(formats.map((f) => [f.getAttribute("name"), f.getAttribute("frameDuration")])).toEqual([
      ["FFVideoFormat1080p60", "1/60s"],
      ["FFVideoFormat1080p30", "1/30s"],
    ]);
    // The asset takes the first placement's name; the file is one asset.
    const steps = Array.from(doc.querySelectorAll("asset")).find((a) => a.getAttribute("name") === "steps A")!;
    expect(steps.getAttribute("format")).toBe(formats[1]!.getAttribute("id"));
  });

  it("a source larger than the output gets its own format; the sequence keeps the output's", () => {
    const doc = parseXml(
      buildFcpxmlKit(spike({ source: { ...spike().source, width: 3840, height: 2160 } })),
    );
    const formats = Array.from(doc.querySelectorAll("format"));
    expect(formats).toHaveLength(3);
    const seq = doc.querySelector("sequence")!;
    const seqFormat = formats.find((f) => f.getAttribute("id") === seq.getAttribute("format"))!;
    expect(seqFormat.getAttribute("width")).toBe("1920");
    const source = Array.from(doc.querySelectorAll("asset")).find((a) => a.getAttribute("name") === "source")!;
    const sourceFormat = formats.find((f) => f.getAttribute("id") === source.getAttribute("format"))!;
    expect(sourceFormat.getAttribute("width")).toBe("3840");
  });

  it("the sequence: output size, total length, stereo 48k, NDF from zero", () => {
    const doc = parseXml(buildFcpxmlKit(spike()));
    const seq = doc.querySelector("sequence")!;
    expect(seq.getAttribute("duration")).toBe("900/60s");
    expect(seq.getAttribute("tcStart")).toBe("0s");
    expect(seq.getAttribute("tcFormat")).toBe("NDF");
    expect(seq.getAttribute("audioLayout")).toBe("stereo");
    expect(seq.getAttribute("audioRate")).toBe("48k");
    expect(doc.querySelector("event")!.getAttribute("name")).toBe("ossclip kit");
    expect(doc.querySelector("project")!.getAttribute("name")).toBe("spike");
  });

  it("a later-span clip is a child of that span", () => {
    const doc = parseXml(buildFcpxmlKit(spike({ clips: [{ ...STEPS, startSec: 7, lengthSec: 1 }] })));
    const spine = Array.from(doc.querySelectorAll("spine > asset-clip"));
    expect(spine[0]!.querySelectorAll("asset-clip")).toHaveLength(0);
    expect(spine[1]!.querySelector("asset-clip")!.getAttribute("offset")).toBe("1860/60s");
  });

  it("a silent clip says hasAudio 0 and carries no audio attributes", () => {
    const doc = parseXml(buildFcpxmlKit(spike({ clips: [{ ...STEPS, hasAudio: false, startSec: 1, lengthSec: 1 }] })));
    const steps = Array.from(doc.querySelectorAll("asset")).find((a) => a.getAttribute("name") === "steps")!;
    expect(steps.getAttribute("hasAudio")).toBe("0");
    expect(steps.hasAttribute("audioSources")).toBe(false);
    expect(steps.hasAttribute("audioChannels")).toBe(false);
    expect(steps.hasAttribute("audioRate")).toBe(false);
  });

  it("a clip cut short keeps the file's own length on its asset", () => {
    const doc = parseXml(buildFcpxmlKit(spike({ clips: [{ ...STEPS, startSec: 1, lengthSec: 2 }] })));
    const steps = Array.from(doc.querySelectorAll("asset")).find((a) => a.getAttribute("name") === "steps")!;
    expect(steps.getAttribute("duration")).toBe("137/30s");
    expect(doc.querySelector("spine > asset-clip > asset-clip")!.getAttribute("duration")).toBe("120/60s");
  });

  it("NTSC 59.94: times in 1001/60000 s, and the format carries no name", () => {
    const fps = 60000 / 1001;
    const doc = parseXml(
      buildFcpxmlKit(spike({ sequence: { width: 1920, height: 1080, fps }, source: { ...spike().source, fps } })),
    );
    const seq = doc.querySelector("sequence")!;
    const seqFormat = Array.from(doc.querySelectorAll("format")).find(
      (f) => f.getAttribute("id") === seq.getAttribute("format"),
    )!;
    expect(seqFormat.getAttribute("frameDuration")).toBe("1001/60000s");
    expect(seqFormat.hasAttribute("name")).toBe(false);
    const first = doc.querySelector("spine > asset-clip")!;
    expect(first.getAttribute("start")).toBe(`${599 * 1001}/60000s`);
    expect(first.getAttribute("duration")).toBe(`${360 * 1001}/60000s`);
  });

  it("names and URLs are escaped and the output is pure ASCII", () => {
    const xml = buildFcpxmlKit(
      spike({
        name: "Démo — A & B's <cut>",
        source: { ...spike().source, name: "take ü \"1\"", url: "file:///C:/a%20&%20b.mp4" },
      }),
    );
    expect(xml).toMatch(/^[\x00-\x7f]*$/);
    const doc = parseXml(xml);
    expect(doc.querySelector("project")!.getAttribute("name")).toBe("Démo — A & B's <cut>");
    const source = Array.from(doc.querySelectorAll("asset"))[0]!;
    expect(source.getAttribute("name")).toBe("take ü \"1\"");
    expect(source.querySelector("media-rep")!.getAttribute("src")).toBe("file:///C:/a%20&%20b.mp4");
  });
});
