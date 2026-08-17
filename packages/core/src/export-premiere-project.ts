import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { keptPauseLabel, keptPauses } from "./export-markers";
import { esc, xmemlRate, xmemlRateXml } from "./export-xmeml-util";
import { mapFromKeptSpans, type KeptSpan } from "./timemap";
import { zoomScaleAt, type ZoomSegment } from "./zoom";
import type { Production } from "./schema";

/**
 * `--format premiere-project` — the produce experience delivered INSIDE
 * Premiere, editable. The marker export (export-premiere-xml.ts) annotates an
 * untouched take; this one applies the cutlist: an xmeml v4 sequence at the
 * OUTPUT frame with one `<clipitem>` per kept span. xmeml trims are
 * non-destructive — dragging a clip edge restores removed material — which is
 * what neutralizes the original "blind cuts" objection to a pre-cut export.
 * Each clip carries a Basic Motion filter reproducing the render's camera:
 * cover-crop base scale × alternating punch-in × cosine-eased zoom keyframes.
 *
 * Same house split as every exporter: plain data in, two strings out; the CLI
 * owns the files. Both strings are pure ASCII (§142 — decades-old consumers
 * silently skip lines they can't decode; no U+2212 anywhere).
 *
 * Cover-crop parity is the FULL-BLEED framing only — VideoStage layouts
 * differ per scene, and v1 deliberately exports the one framing every scene
 * shares (plan 2026-08-13, known risks).
 */

/** The slice of a caption line the SRT needs — start/end are OUTPUT seconds. */
export interface SrtLine {
  words: readonly { text: string }[];
  start: number;
  end: number;
}

export interface PremiereProjectInput {
  production: Production;
  spans: readonly KeptSpan[];
  captionLines: readonly SrtLine[];
  zoomPlan: readonly ZoomSegment[];
  /** render-props' flag: true disables BOTH motion layers (zoom AND punch). */
  staticCamera?: boolean;
  /**
   * render-props' `punch` — the face-only jump-cut plan (2026-08-16, scenes'
   * punch-plan.ts): its scale replaces the legacy 1.07 and its mask gates
   * which spans punch. Absent means the LEGACY contract, so a pre-feature
   * workdir exports exactly the camera its render had.
   */
  punch?: { scale: number; allowed: readonly boolean[] } | null;
  /** The OUTPUT frame (production.render), e.g. 1080×1920. */
  frame: { width: number; height: number };
}

/**
 * The render's jump-cut concealer, replicated from scenes' `punchScalesFor`
 * (punch-plan.ts, the loop EdlVideo renders) — the alternating toggle, the
 * srcIn−prev.srcOut gap, and the INCLUSIVE >= threshold must all match, or
 * the exported project punches different clips than the render did. The
 * `allowed` mask must match too, down to the parity rule: the toggle flips
 * on EVERY qualifying gap, masked spans included (stable indexing), and a
 * masked span renders its punched turn at 1. `allowed[i] !== false` so a
 * short mask reads as allowed, same as no mask at all. Defaults mirror
 * EdlVideoProps; they are parameters so a drift in either place shows up as
 * a failing hand-computed test, not a silent divergence.
 */
export function punchScales(
  spans: readonly KeptSpan[],
  punchInScale = 1.07,
  punchThresholdSec = 0.15,
  allowed?: readonly boolean[] | null,
): number[] {
  const out: number[] = [];
  let punched = false;
  for (let i = 0; i < spans.length; i++) {
    const prev = spans[i - 1];
    const gap = prev ? spans[i]!.srcIn - prev.srcOut : 0;
    if (i > 0 && gap >= punchThresholdSec) punched = !punched;
    out.push(punched && (!allowed || allowed[i] !== false) ? punchInScale : 1);
  }
  return out;
}

/**
 * The full-bleed cover-crop as Basic Motion parameters. Premiere imports a
 * source 1:1-pixel centered in the sequence, so the cover factor —
 * max(frame/probe) per axis, the CSS `object-fit: cover` rule the render
 * uses — maps directly onto the scale percent (100 = native size). The
 * center offset re-centers the measured face point and is clamped so the
 * scaled picture never reveals an edge: |offset| ≤ (scaledDim − frameDim)/2
 * per axis — the same "never show the backing" guarantee cover gives the
 * render. xmeml center units: fractions of the sequence dimension, 0 =
 * centered. No face → centered, exactly like the render's 50% default.
 */
export function coverTransform(
  probe: { width: number; height: number },
  face: { centerXFrac: number; centerYFrac: number } | null | undefined,
  frame: { width: number; height: number },
): { scalePct: number; centerH: number; centerV: number } {
  const scale = Math.max(frame.width / probe.width, frame.height / probe.height);
  const offset = (scaledDim: number, frameDim: number, frac: number): number => {
    const slack = (scaledDim - frameDim) / 2;
    const want = scaledDim * (0.5 - frac);
    return Math.max(-slack, Math.min(slack, want));
  };
  return {
    scalePct: scale * 100,
    centerH: face ? offset(probe.width * scale, frame.width, face.centerXFrac) / frame.width : 0,
    centerV: face ? offset(probe.height * scale, frame.height, face.centerYFrac) / frame.height : 0,
  };
}

/**
 * Zoom samples for one clip's output window, in OUTPUT seconds: segment
 * endpoints plus two interior points per ramp (a cosine ease through four
 * points reads as the ease; through two it reads as linear). Only this
 * clip's own segments are consulted — `zoomScaleAt` matches half-open, so at
 * the clip's final instant the unfiltered plan would answer with the NEXT
 * clip's reset instead of this clip's hold (zoom.ts's boundary note).
 * Interior samples of a constant run are dropped; a hold keeps only its
 * endpoints.
 */
export function zoomKeyframesFor(
  span: KeptSpan,
  zoomPlan: readonly ZoomSegment[],
): { tSec: number; scale: number }[] {
  const segs = zoomPlan.filter((s) => s.startSec < span.outOut && s.endSec > span.outIn);
  const times = new Set<number>([span.outIn, span.outOut]);
  for (const seg of segs) {
    const a = Math.max(seg.startSec, span.outIn);
    const b = Math.min(seg.endSec, span.outOut);
    times.add(a);
    times.add(b);
    if (seg.from !== seg.to) {
      times.add(a + (b - a) / 3);
      times.add(a + (2 * (b - a)) / 3);
    }
  }
  const samples = [...times]
    .sort((x, y) => x - y)
    .map((tSec) => ({ tSec, scale: zoomScaleAt(segs, tSec) }));
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return samples.filter((cur, i) => {
    const prev = samples[i - 1];
    const next = samples[i + 1];
    // Interior of a constant run — the run's endpoints carry the hold.
    return !(prev && next && eq(prev.scale, cur.scale) && eq(cur.scale, next.scale));
  });
}

/**
 * Keyframe `<when>` domain: CLIP-RELATIVE frames — the one xmeml spec detail
 * memory can't settle (media-time vs clip-time; the plan's stated open
 * risk). Kept as a single function so the §142 fail-fast field smoke can
 * flip the domain with a one-line change plus its test, not a hunt through
 * the emitter.
 */
export function keyframeWhen(span: KeptSpan, tSec: number, fps: number): number {
  return Math.round((tSec - span.outIn) * fps);
}

/** HH:MM:SS,mmm — the comma is SRT's own; everything here is ASCII (§142). */
function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:` +
    `${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`
  );
}

/**
 * Captions as SRT, in output (sequence) time so the file drops straight onto
 * the exported timeline. Word-level karaoke timing does not survive SRT —
 * the format has no word granularity — so a line is its words joined.
 */
export function srtFromCaptionLines(lines: readonly SrtLine[]): string {
  return lines
    .map(
      (line, i) =>
        `${i + 1}\n${srtTime(line.start)} --> ${srtTime(line.end)}\n` +
        `${line.words.map((w) => w.text).join(" ")}\n`,
    )
    .join("\n");
}

/** Keyframes numeric noise-floor: 4 decimals is sub-0.001% of scale. */
const fmt = (n: number): string => String(Number(n.toFixed(4)));

export function buildPremiereProject(input: PremiereProjectInput): { xml: string; srt: string } {
  const { production, spans, captionLines, zoomPlan, staticCamera, punch, frame } = input;
  const { path, probe } = production.source;
  // The whole document runs at the SOURCE rate (the marker exporter's
  // precedent): clip in/out and sequence start/end share one timebase, so no
  // frame position depends on Premiere's rate conform.
  const { timebase, ntsc } = xmemlRate(probe.fps);
  const toFrames = (sec: number) => Math.round(sec * probe.fps);
  const name = esc(basename(path));
  const rateXml = (indent: string) => xmemlRateXml(indent, timebase, ntsc);
  const outputEnd = spans.length > 0 ? spans[spans.length - 1]!.outOut : 0;
  const durFrames = toFrames(outputEnd);

  const cover = coverTransform(probe, production.source.face, frame);
  // staticCamera kills BOTH motion drivers (produce's render-props contract:
  // zoomPlan alone can't reach the punch) — cover-crop is all that remains.
  // Otherwise the punch plan's scale and mask apply when present; `punch?.`
  // collapses both absent and null to undefined, which punchScales reads as
  // the legacy 1.07-everywhere the render itself falls back to.
  const punches = staticCamera
    ? spans.map(() => 1)
    : punchScales(spans, punch?.scale, undefined, punch?.allowed);

  // Per-clip frame geometry. A sub-frame span still occupies one frame on
  // both axes — a zero-length clipitem is undefined importer behavior, same
  // rule as the marker exporter's zero-length span.
  const geo = spans.map((sp) => {
    const start = toFrames(sp.outIn);
    const srcIn = toFrames(sp.srcIn);
    return {
      start,
      end: Math.max(start + 1, toFrames(sp.outOut)),
      in: srcIn,
      out: Math.max(srcIn + 1, toFrames(sp.srcOut)),
    };
  });

  const scaleParam = (sp: KeptSpan, punch: number, indent: string): string => {
    const kfs = staticCamera ? [] : zoomKeyframesFor(sp, zoomPlan);
    const values = kfs.map((k) => ({ when: keyframeWhen(sp, k.tSec, probe.fps), value: cover.scalePct * punch * k.scale }));
    // A motionless clip (staticCamera, or a plan that never moves it) gets a
    // plain static value — two identical keyframes would read as "animated"
    // in Effect Controls for no reason.
    const still =
      values.length < 2 || values.every((v) => Math.abs(v.value - values[0]!.value) < 1e-9);
    const body = still
      ? `${indent}  <value>${fmt(values[0]?.value ?? cover.scalePct * punch)}</value>`
      : values
          .map(
            (v) =>
              `${indent}  <keyframe>\n${indent}    <when>${v.when}</when>\n` +
              `${indent}    <value>${fmt(v.value)}</value>\n${indent}  </keyframe>`,
          )
          .join("\n");
    return (
      `${indent}<parameter>\n` +
      `${indent}  <parameterid>scale</parameterid>\n` +
      `${indent}  <name>Scale</name>\n` +
      `${indent}  <valuemin>0</valuemin>\n` +
      `${indent}  <valuemax>1000</valuemax>\n` +
      body + "\n" +
      `${indent}</parameter>`
    );
  };

  const basicMotion = (sp: KeptSpan, punch: number, indent: string): string =>
    `${indent}<filter>\n` +
    `${indent}  <effect>\n` +
    `${indent}    <name>Basic Motion</name>\n` +
    `${indent}    <effectid>basic</effectid>\n` +
    `${indent}    <effectcategory>motion</effectcategory>\n` +
    `${indent}    <effecttype>motion</effecttype>\n` +
    `${indent}    <mediatype>video</mediatype>\n` +
    scaleParam(sp, punch, `${indent}    `) + "\n" +
    `${indent}    <parameter>\n` +
    `${indent}      <parameterid>center</parameterid>\n` +
    `${indent}      <name>Center</name>\n` +
    `${indent}      <value>\n` +
    `${indent}        <horiz>${fmt(cover.centerH)}</horiz>\n` +
    `${indent}        <vert>${fmt(cover.centerV)}</vert>\n` +
    `${indent}      </value>\n` +
    `${indent}    </parameter>\n` +
    `${indent}  </effect>\n` +
    `${indent}</filter>`;

  // Both clipitems of a pair carry both links (xmeml convention, same as the
  // marker exporter's field fix 2): this is what makes Premiere treat Vn+An
  // as ONE linked clip instead of two strangers.
  const links = (i: number, indent: string): string =>
    !probe.hasAudio
      ? ""
      : `${indent}<link>\n` +
        `${indent}  <linkclipref>ci-v${i}</linkclipref>\n` +
        `${indent}  <mediatype>video</mediatype>\n` +
        `${indent}  <trackindex>1</trackindex>\n` +
        `${indent}  <clipindex>${i + 1}</clipindex>\n` +
        `${indent}</link>\n` +
        `${indent}<link>\n` +
        `${indent}  <linkclipref>ci-a${i}</linkclipref>\n` +
        `${indent}  <mediatype>audio</mediatype>\n` +
        `${indent}  <trackindex>1</trackindex>\n` +
        `${indent}  <clipindex>${i + 1}</clipindex>\n` +
        `${indent}</link>`;

  // The file is DEFINED once (first video clipitem) and referenced by id
  // everywhere else — repeating full definitions is how importers end up
  // with N copies of one clip in the project panel.
  const fileXml = (first: boolean, indent: string): string =>
    first
      ? `${indent}<file id="f-1">\n` +
        `${indent}  <name>${name}</name>\n` +
        `${indent}  <pathurl>${esc(pathToFileURL(path).href)}</pathurl>\n` +
        xmemlRateXml(`${indent}  `, timebase, ntsc) + "\n" +
        `${indent}  <duration>${toFrames(probe.duration)}</duration>\n` +
        `${indent}  <media>\n` +
        `${indent}    <video>\n` +
        `${indent}      <samplecharacteristics>\n` +
        `${indent}        <width>${probe.width}</width>\n` +
        `${indent}        <height>${probe.height}</height>\n` +
        `${indent}      </samplecharacteristics>\n` +
        `${indent}    </video>${probe.hasAudio ? `\n${indent}    <audio>\n${indent}      <channelcount>2</channelcount>\n${indent}    </audio>` : ""}\n` +
        `${indent}  </media>\n` +
        `${indent}</file>`
      : `${indent}<file id="f-1"/>`;

  const videoClips = spans
    .map((sp, i) => {
      const g = geo[i]!;
      return (
        `          <clipitem id="ci-v${i}">\n` +
        `            <name>${name}</name>\n` +
        `            <duration>${toFrames(probe.duration)}</duration>\n` +
        rateXml("            ") + "\n" +
        `            <start>${g.start}</start>\n` +
        `            <end>${g.end}</end>\n` +
        `            <in>${g.in}</in>\n` +
        `            <out>${g.out}</out>\n` +
        fileXml(i === 0, "            ") + "\n" +
        basicMotion(sp, punches[i]!, "            ") + "\n" +
        (probe.hasAudio ? links(i, "            ") + "\n" : "") +
        `          </clipitem>`
      );
    })
    .join("\n");

  const audioClips = !probe.hasAudio
    ? ""
    : spans
        .map((_sp, i) => {
          const g = geo[i]!;
          return (
            `          <clipitem id="ci-a${i}">\n` +
            `            <name>${name}</name>\n` +
            `            <duration>${toFrames(probe.duration)}</duration>\n` +
            rateXml("            ") + "\n" +
            `            <start>${g.start}</start>\n` +
            `            <end>${g.end}</end>\n` +
            `            <in>${g.in}</in>\n` +
            `            <out>${g.out}</out>\n` +
            `            <file id="f-1"/>\n` +
            `            <sourcetrack>\n` +
            `              <mediatype>audio</mediatype>\n` +
            `              <trackindex>1</trackindex>\n` +
            `            </sourcetrack>\n` +
            links(i, "            ") + "\n" +
            `          </clipitem>`
          );
        })
        .join("\n");

  // Kept pauses still ride the sequence (§142 round 2) — they are the
  // "detected but kept" overview the field editor asked for. The cuts
  // themselves are APPLIED here, so no cut markers: the cut IS the edit.
  // Pause times are source seconds; the sequence runs in output time, so
  // they map through the spans (clamped — a pause never overlaps a remove,
  // but its edges can graze one).
  const map = mapFromKeptSpans(spans);
  const markers = keptPauses(production)
    .map((p) => ({ start: map.toOutputClamped(p.start), end: map.toOutputClamped(p.end), label: keptPauseLabel(p) }))
    .filter((m) => m.end > m.start)
    .map(
      (m) =>
        `    <marker>\n` +
        `      <name>${esc(m.label)}</name>\n` +
        `      <comment>ossclip detected pause - kept, below the cut bar</comment>\n` +
        `      <in>${toFrames(m.start)}</in>\n` +
        `      <out>${Math.max(toFrames(m.start) + 1, toFrames(m.end))}</out>\n` +
        `    </marker>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="ossclip-project">
    <name>${name} - ossclip cut</name>
    <duration>${durFrames}</duration>
${rateXml("    ")}
    <timecode>
${rateXml("      ")}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>${ntsc ? "DF" : "NDF"}</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
${rateXml("            ")}
            <width>${frame.width}</width>
            <height>${frame.height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>
${videoClips}
        </track>
      </video>${
        probe.hasAudio
          ? `
      <audio>
        <track>
${audioClips}
        </track>
      </audio>`
          : ""
      }
    </media>
${markers ? `${markers}\n` : ""}  </sequence>
</xmeml>
`;

  return { xml, srt: srtFromCaptionLines(captionLines) };
}
