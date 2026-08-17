import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  buildPremiereProject,
  coverTransform,
  keyframeWhen,
  punchScales,
  srtFromCaptionLines,
  zoomKeyframesFor,
} from "../src/export-premiere-project";
import { xmemlRate } from "../src/export-xmeml-util";
import type { KeptSpan } from "../src/timemap";
import type { Production } from "../src/schema";
import type { ZoomSegment } from "../src/zoom";

/**
 * `--format premiere-project` (§142's dialect lessons applied): an xmeml v4
 * sequence with the cutlist APPLIED — one clipitem per kept span, trims
 * non-destructive — plus Basic Motion scale keyframes replicating the render's
 * camera motion, and an SRT sidecar for the captions. Fixture numbers are
 * hand-computed; nothing here round-trips through the code under test.
 */

/** Landscape 1920x1080@30 source into the default 9:16 output frame. */
function production(overrides: Partial<Production> = {}): Production {
  return {
    version: 1,
    source: {
      path: "/takes/demo.mp4",
      probe: { duration: 30, width: 1920, height: 1080, fps: 30, hasAudio: true },
    },
    cleanup: "standard",
    cutlist: [
      { srcIn: 1, srcOut: 11, kind: "keep" },
      { srcIn: 11, srcOut: 12, kind: "remove", reason: "silence" },
      { srcIn: 12, srcOut: 20, kind: "keep" },
    ],
    render: { width: 1080, height: 1920, fps: 30 },
    ...overrides,
  };
}

/** Two kept spans with a 1s removed gap — long enough to toggle the punch. */
const SPANS: KeptSpan[] = [
  { srcIn: 1, srcOut: 11, outIn: 0, outOut: 10 },
  { srcIn: 12, srcOut: 20, outIn: 10, outOut: 18 },
];

/** The plan buildZoomPlan would emit for those spans (8s ramp, 1.05 max). */
const ZOOM: ZoomSegment[] = [
  { startSec: 0, endSec: 8, from: 1, to: 1.05 },
  { startSec: 8, endSec: 10, from: 1.05, to: 1.05 },
  { startSec: 10, endSec: 18, from: 1, to: 1.05 },
];

const FRAME = { width: 1080, height: 1920 };

function build(overrides: Partial<Parameters<typeof buildPremiereProject>[0]> = {}) {
  return buildPremiereProject({
    production: production(),
    spans: SPANS,
    captionLines: [
      { words: [{ text: "hello" }, { text: "there" }], start: 0.5, end: 2 },
      { words: [{ text: "again" }], start: 61.25, end: 63.5 },
    ],
    zoomPlan: ZOOM,
    frame: FRAME,
    ...overrides,
  });
}

function parseXml(xml: string): Document {
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

describe("punchScales", () => {
  it("replicates EdlVideo's alternating toggle across the 0.15s threshold exactly", () => {
    // Gaps: 0.1 (below — no toggle), 0.2 (toggle), 0.15 (>= is inclusive —
    // toggle), 0.3 (toggle). EdlVideo.tsx:47 is the reference implementation.
    const spans: KeptSpan[] = [
      { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
      { srcIn: 2.1, srcOut: 4, outIn: 2, outOut: 3.9 },
      { srcIn: 4.2, srcOut: 6, outIn: 3.9, outOut: 5.7 },
      { srcIn: 6.15, srcOut: 8, outIn: 5.7, outOut: 7.55 },
      { srcIn: 8.3, srcOut: 10, outIn: 7.55, outOut: 9.25 },
    ];
    expect(punchScales(spans)).toEqual([1, 1, 1.07, 1, 1.07]);
  });

  it("honours a custom scale and threshold", () => {
    const spans: KeptSpan[] = [
      { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
      { srcIn: 2.1, srcOut: 4, outIn: 2, outOut: 3.9 },
    ];
    expect(punchScales(spans, 1.2, 0.05)).toEqual([1, 1.2]);
  });

  // The allowed mask (Task 6), lockstep with scenes' punchScalesFor — same
  // span fixture, same expected scales, in punch-plan.test.ts over there.
  it("a masked span punches at 1 without re-phasing the toggle; a short mask reads as allowed", () => {
    const spans: KeptSpan[] = [
      { srcIn: 0, srcOut: 2, outIn: 0, outOut: 2 },
      { srcIn: 2.1, srcOut: 4, outIn: 2, outOut: 3.9 },
      { srcIn: 4.2, srcOut: 6, outIn: 3.9, outOut: 5.7 },
      { srcIn: 6.15, srcOut: 8, outIn: 5.7, outOut: 7.55 },
      { srcIn: 8.3, srcOut: 10, outIn: 7.55, outOut: 9.25 },
    ];
    // Span 2 masked, span 4 still punches: the toggle flips on every
    // qualifying gap regardless of the mask (stable indexing).
    expect(punchScales(spans, 1.015, 0.15, [true, true, false, true, true])).toEqual([
      1, 1, 1, 1, 1.015,
    ]);
    expect(punchScales(spans, 1.015, 0.15, [true, true])).toEqual([1, 1, 1.015, 1, 1.015]);
  });
});

describe("coverTransform", () => {
  it("no face → cover scale, centered", () => {
    const t = coverTransform({ width: 1920, height: 1080 }, null, FRAME);
    // Landscape into 9:16 covers on HEIGHT: 1920/1080 = 16/9.
    expect(t.scalePct).toBeCloseTo((1920 / 1080) * 100, 6);
    expect(t.centerH).toBe(0);
    expect(t.centerV).toBe(0);
  });

  it("face offset recenters the face point, normalized to sequence size", () => {
    const t = coverTransform(
      { width: 1920, height: 1080 },
      { centerXFrac: 0.6, centerYFrac: 0.5 },
      FRAME,
    );
    // Scaled width = 1920·(16/9) = 10240/3. Offset = sw·(0.5−0.6) = −1024/3 px,
    // inside the ±(sw−1080)/2 bound; normalized by the sequence width.
    expect(t.centerH).toBeCloseTo(-1024 / 3 / 1080, 6);
    // Scaled height exactly fills the frame — no vertical slack, so 0.
    expect(t.centerV).toBe(0);
  });

  it("clamps so the scaled picture never reveals an edge", () => {
    const t = coverTransform(
      { width: 1920, height: 1080 },
      { centerXFrac: 0.99, centerYFrac: 0.5 },
      FRAME,
    );
    // Unclamped offset would be sw·(0.5−0.99) ≈ −1672.5px; the bound is
    // (sw−1080)/2 = 3506.67/2... = (10240/3 − 1080)/2.
    const bound = (1920 * (1920 / 1080) - 1080) / 2;
    expect(t.centerH).toBeCloseTo(-bound / 1080, 6);
  });
});

describe("zoomKeyframesFor", () => {
  it("samples ramp start, two cosine midpoints, ramp end and clip end", () => {
    const kfs = zoomKeyframesFor(SPANS[0]!, ZOOM);
    expect(kfs.map((k) => k.tSec)).toEqual([0, 8 / 3, 16 / 3, 8, 10]);
    // Cosine ease at p=1/3 is 0.25, at p=2/3 is 0.75 (hand-computed).
    expect(kfs[0]!.scale).toBeCloseTo(1, 9);
    expect(kfs[1]!.scale).toBeCloseTo(1.0125, 9);
    expect(kfs[2]!.scale).toBeCloseTo(1.0375, 9);
    expect(kfs[3]!.scale).toBeCloseTo(1.05, 9);
    expect(kfs[4]!.scale).toBeCloseTo(1.05, 9);
  });

  it("the second clip resets to 1 — its own plan segment, not the first clip's hold", () => {
    const kfs = zoomKeyframesFor(SPANS[1]!, ZOOM);
    expect(kfs[0]).toEqual({ tSec: 10, scale: 1 });
    expect(kfs[kfs.length - 1]!.scale).toBeCloseTo(1.05, 9);
  });

  it("an empty plan yields a hold at 1 — endpoints only", () => {
    const kfs = zoomKeyframesFor(SPANS[0]!, []);
    expect(kfs).toEqual([
      { tSec: 0, scale: 1 },
      { tSec: 10, scale: 1 },
    ]);
  });

  it("a span the face-only zoom gate left segment-free is a flat hold at 1 — F1 needs zero exporter changes", () => {
    // buildZoomPlan's allowedClips (zoom.ts) emits NOTHING for a
    // screen-subject clip: only the first clip's segments exist here. The
    // span filter is strict (`endSec > outIn`), so the first clip's hold
    // ending exactly at outIn=10 is NOT consulted and the static span reads
    // scale 1 throughout — the `still` collapse below then writes one plain
    // <value>, no keyframes.
    const gated: ZoomSegment[] = [
      { startSec: 0, endSec: 8, from: 1, to: 1.05 },
      { startSec: 8, endSec: 10, from: 1.05, to: 1.05 },
    ];
    expect(zoomKeyframesFor(SPANS[1]!, gated)).toEqual([
      { tSec: 10, scale: 1 },
      { tSec: 18, scale: 1 },
    ]);
    // End-to-end through the emitter: the gated span gets a static cover
    // value while the allowed span keeps its keyframed push.
    const doc = parseXml(build({ zoomPlan: gated }).xml);
    const clips = Array.from(doc.querySelectorAll("video > track > clipitem"));
    const scaleParam = (clip: Element) =>
      Array.from(clip.querySelectorAll("parameter")).find(
        (p) => p.querySelector("parameterid")?.textContent === "scale",
      )!;
    expect(scaleParam(clips[0]!).querySelectorAll("keyframe").length).toBeGreaterThan(0);
    const staticScale = scaleParam(clips[1]!);
    expect(staticScale.querySelector("keyframe")).toBeNull();
    // Legacy 1.07 punch (no punch plan passed) on the bare cover scale.
    expect(Number(staticScale.querySelector("value")!.textContent)).toBeCloseTo(
      (1600 / 9) * 1.07,
      3,
    );
  });
});

describe("keyframeWhen", () => {
  it("is CLIP-relative frames (the §142 open risk — one function so the smoke test can flip the domain)", () => {
    expect(keyframeWhen(SPANS[1]!, 12, 30)).toBe(60);
    expect(keyframeWhen(SPANS[1]!, 10, 30)).toBe(0);
  });
});

describe("srtFromCaptionLines", () => {
  it("emits the golden block format in output time", () => {
    const srt = srtFromCaptionLines([
      { words: [{ text: "hello" }, { text: "there" }], start: 0.5, end: 2 },
      { words: [{ text: "again" }], start: 61.25, end: 63.5 },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,500 --> 00:00:02,000\nhello there\n\n" +
        "2\n00:01:01,250 --> 00:01:03,500\nagain\n",
    );
  });

  it("no lines → empty string, not a lone index", () => {
    expect(srtFromCaptionLines([])).toBe("");
  });
});

describe("buildPremiereProject", () => {
  it("one clipitem per kept span: in/out are SOURCE frames, start/end OUTPUT frames", () => {
    const doc = parseXml(build().xml);
    const clips = Array.from(doc.querySelectorAll("video > track > clipitem"));
    expect(clips).toHaveLength(2);
    expect(clips[0]!.querySelector("in")!.textContent).toBe("30");
    expect(clips[0]!.querySelector("out")!.textContent).toBe("330");
    expect(clips[0]!.querySelector("start")!.textContent).toBe("0");
    expect(clips[0]!.querySelector("end")!.textContent).toBe("300");
    expect(clips[1]!.querySelector("in")!.textContent).toBe("360");
    expect(clips[1]!.querySelector("out")!.textContent).toBe("600");
    expect(clips[1]!.querySelector("start")!.textContent).toBe("300");
    expect(clips[1]!.querySelector("end")!.textContent).toBe("540");
  });

  it("the sequence is the OUTPUT frame, not the source's", () => {
    const doc = parseXml(build().xml);
    const fmt = doc.querySelector("sequence > media > video > format > samplecharacteristics")!;
    expect(fmt.querySelector("width")!.textContent).toBe("1080");
    expect(fmt.querySelector("height")!.textContent).toBe("1920");
  });

  it("every video clipitem is linked to a matching audio clipitem", () => {
    const doc = parseXml(build().xml);
    const audioClips = Array.from(doc.querySelectorAll("audio > track > clipitem"));
    expect(audioClips).toHaveLength(2);
    // Same trims as the video — the pair moves as one clip.
    expect(audioClips[0]!.querySelector("in")!.textContent).toBe("30");
    expect(audioClips[1]!.querySelector("start")!.textContent).toBe("300");
    const links = Array.from(doc.querySelectorAll("clipitem > link"));
    // Two links (video+audio) on each of the 4 clipitems.
    expect(links).toHaveLength(8);
  });

  it("a silent source emits no audio track and no links", () => {
    const p = production();
    p.source.probe.hasAudio = false;
    const doc = parseXml(build({ production: p }).xml);
    expect(doc.querySelector("audio > track > clipitem")).toBeNull();
    expect(doc.querySelector("link")).toBeNull();
  });

  it("Basic Motion scale keyframes: cover base × punch × cosine zoom, hand-computed", () => {
    const doc = parseXml(build().xml);
    const clips = Array.from(doc.querySelectorAll("video > track > clipitem"));
    const kf = (clip: Element) =>
      Array.from(clip.querySelectorAll("parameter")).find(
        (p) => p.querySelector("parameterid")?.textContent === "scale",
      )!;
    const values = (clip: Element) =>
      Array.from(kf(clip).querySelectorAll("keyframe")).map((k) => ({
        when: Number(k.querySelector("when")!.textContent),
        value: Number(k.querySelector("value")!.textContent),
      }));
    // Clip 1: base 1600/9 ≈ 177.7778 (cover), no punch. 8/3s → ×1.0125 = 180.
    const v1 = values(clips[0]!);
    expect(v1.map((k) => k.when)).toEqual([0, 80, 160, 240, 300]);
    expect(v1[0]!.value).toBeCloseTo(1600 / 9, 3);
    expect(v1[1]!.value).toBeCloseTo(180, 3);
    expect(v1[2]!.value).toBeCloseTo((1600 / 9) * 1.0375, 3);
    expect(v1[3]!.value).toBeCloseTo((1600 / 9) * 1.05, 3);
    expect(v1[4]!.value).toBeCloseTo((1600 / 9) * 1.05, 3);
    // Clip 2: punched ×1.07, ramp covers the whole 8s clip.
    const v2 = values(clips[1]!);
    expect(v2[0]!.when).toBe(0);
    expect(v2[0]!.value).toBeCloseTo((1600 / 9) * 1.07, 3);
    expect(v2[v2.length - 1]!.value).toBeCloseTo((1600 / 9) * 1.07 * 1.05, 3);
  });

  it("render-props' punch plan drives the export: its scale on allowed punched spans, base on masked ones", () => {
    const staticScales = (xml: string) =>
      Array.from(parseXml(xml).querySelectorAll("parameter"))
        .filter((p) => p.querySelector("parameterid")?.textContent === "scale")
        .map((p) => Number(p.querySelector("value")!.textContent));
    // Clip 2 is the punched turn (the 1s gap toggles) and its mask allows:
    // it exports at the PLAN's 1.015, not the legacy 1.07.
    const allowed = staticScales(
      build({ punch: { scale: 1.015, allowed: [true, true] }, zoomPlan: [] }).xml,
    );
    expect(allowed[0]).toBeCloseTo(1600 / 9, 3);
    expect(allowed[1]).toBeCloseTo((1600 / 9) * 1.015, 3);
    // Same parity, mask false on the punched span: bare cover scale — the
    // render's EdlVideo suppressed it, so the export must too.
    const masked = staticScales(
      build({ punch: { scale: 1.015, allowed: [true, false] }, zoomPlan: [] }).xml,
    );
    expect(masked[0]).toBeCloseTo(1600 / 9, 3);
    expect(masked[1]).toBeCloseTo(1600 / 9, 3);
  });

  it("staticCamera disables BOTH motion layers: static scale, no keyframes, no punch", () => {
    const doc = parseXml(build({ staticCamera: true, zoomPlan: [] }).xml);
    expect(doc.querySelector("keyframe")).toBeNull();
    const scales = Array.from(doc.querySelectorAll("parameter"))
      .filter((p) => p.querySelector("parameterid")?.textContent === "scale")
      .map((p) => Number(p.querySelector("value")!.textContent));
    expect(scales).toHaveLength(2);
    for (const s of scales) expect(s).toBeCloseTo(1600 / 9, 3);
  });

  it("face offset lands in the center parameter", () => {
    const p = production();
    p.source.face = {
      centerXFrac: 0.6,
      centerYFrac: 0.5,
      sizeFrac: 0.2,
      framesSampled: 10,
      framesDetected: 10,
    };
    const doc = parseXml(build({ production: p }).xml);
    const center = Array.from(doc.querySelectorAll("parameter")).find(
      (el) => el.querySelector("parameterid")?.textContent === "center",
    )!;
    expect(Number(center.querySelector("horiz")!.textContent)).toBeCloseTo(-1024 / 3 / 1080, 3);
    expect(Number(center.querySelector("vert")!.textContent)).toBe(0);
  });

  it("kept pauses ride the sequence as markers, mapped source→output", () => {
    const p = production();
    p.analysis = {
      silences: [],
      gaps: [],
      breaths: [],
      fillers: [],
      cuttable: [{ start: 3, end: 3.4 }],
    } as NonNullable<Production["analysis"]>;
    const doc = parseXml(build({ production: p }).xml);
    const marker = doc.querySelector("sequence > marker")!;
    expect(marker.querySelector("name")!.textContent).toBe("pause 0.40s (kept)");
    // Source 3–3.4 sits in span 1 (srcIn 1 → outIn 0): output 2–2.4 at 30fps.
    expect(marker.querySelector("in")!.textContent).toBe("60");
    expect(marker.querySelector("out")!.textContent).toBe("72");
  });

  it("a sub-frame span still occupies at least one frame", () => {
    const spans: KeptSpan[] = [{ srcIn: 5, srcOut: 5.01, outIn: 0, outOut: 0.01 }];
    const doc = parseXml(build({ spans, zoomPlan: [] }).xml);
    const clip = doc.querySelector("video > track > clipitem")!;
    expect(clip.querySelector("in")!.textContent).toBe("150");
    expect(clip.querySelector("out")!.textContent).toBe("151");
    expect(clip.querySelector("start")!.textContent).toBe("0");
    expect(clip.querySelector("end")!.textContent).toBe("1");
  });

  it("NTSC source: '30 TRUE' via xmemlRate", () => {
    const p = production();
    p.source.probe.fps = 30000 / 1001;
    const doc = parseXml(build({ production: p }).xml);
    const rate = doc.querySelector("sequence > rate")!;
    expect(rate.querySelector("timebase")!.textContent).toBe("30");
    expect(rate.querySelector("ntsc")!.textContent).toBe("TRUE");
    // The extracted helper is the single source of that mapping.
    expect(xmemlRate(30000 / 1001)).toEqual({ timebase: 30, ntsc: true });
  });

  it("both outputs are pure ASCII — §142: decades-old consumers silently skip lines", () => {
    const { xml, srt } = build();
    expect(xml).toMatch(/^[\x00-\x7F]*$/);
    expect(srt).toMatch(/^[\x00-\x7F]*$/);
  });
});
