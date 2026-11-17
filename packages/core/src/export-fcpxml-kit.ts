import { fpsToFrameDuration, type FrameDuration } from "./export-fcpxml";
import { esc } from "./export-xmeml-util";
import type { KeptSpan } from "./timemap";

/**
 * The clip kit's timeline (§162, design 3.3): FCPXML 1.10 with the cut
 * source on the main track, one asset-clip per kept span, and each scene
 * clip on lane 1. Pure by the house split — data in, XML string out; the
 * CLI owns the files and the probes.
 *
 * The shape is the one the Resolve 21 spike (2026-11-16) imported: Resolve
 * drops FCPXML markers (§142) and refused the xmeml form's `file:///C:/`
 * paths, so only what the spike proved is written — a scene clip is an
 * anchored `<asset-clip lane="1">` child of the span it starts in, never a
 * clip split at a cut (the spike's second clip ran across two cut points
 * as one item, which is what the author wants to move as one thing).
 */

/** One media file the timeline references. */
export interface KitTimelineMedia {
  /** A `file://` URL, from `kitFileUrl` (Resolve may run on the Windows side of WSL). */
  url: string;
  name: string;
  /** The file's own rate and size: its `<format>`, and the frames of its asset `duration`. */
  fps: number;
  width: number;
  height: number;
  /** The whole file's length. */
  durationSec: number;
  hasAudio: boolean;
}

export interface KitTimelineInput {
  /** The project's name in Resolve. */
  name: string;
  /** Output frame size, SOURCE frame rate (plan decision 4). */
  sequence: { width: number; height: number; fps: number };
  source: KitTimelineMedia;
  spans: readonly KeptSpan[];
  /**
   * `startSec` on the output timeline. `lengthSec` is how long the clip is
   * on the timeline, and may be shorter than `durationSec` (a `clip:`
   * scene cut short); the asset keeps the file's own length.
   */
  clips: readonly (KitTimelineMedia & { startSec: number; lengthSec: number })[];
}

/** A kept span on track 1, in sequence frames. */
export interface KitTimelineSpan {
  /** Where it sits on the timeline. */
  offset: number;
  /** Its in-point in the source. */
  start: number;
  duration: number;
}

/** A scene clip on lane 1, in sequence frames. */
export interface KitTimelineClip {
  /** Index into `KitTimelineInput.clips`. */
  clip: number;
  /** Index into `KitTimelineFrames.spans` — the span it is attached to. */
  span: number;
  /** In the parent span's SOURCE time, as FCPXML places an anchored clip. */
  offset: number;
  duration: number;
}

/** The timeline as whole sequence frames; every number is an integer. */
export interface KitTimelineFrames {
  frameDuration: FrameDuration;
  durationFrames: number;
  spans: KitTimelineSpan[];
  clips: KitTimelineClip[];
}

/**
 * Seconds → whole frames of `fd`. Through the rational, not `× fps`, so an
 * NTSC 59.94 timeline counts frames of exactly 1001/60000 s — the unit
 * every time attribute is written in.
 */
function framesAt(sec: number, fd: FrameDuration): number {
  return Math.round((sec * fd.den) / fd.num);
}

/**
 * The frame arithmetic, separate from the XML so the numbers are tested as
 * numbers.
 *
 * Spans: boundary i is span i's `outIn` in frames (the last span's end is
 * its `outOut`), and a span runs from its boundary to the next one — the
 * §115 rule, end from end, so rounded spans never gap or overlap and the
 * spine's offsets are its running sum. A span that rounds to zero frames is
 * dropped; its neighbours already meet.
 *
 * Every span also stays inside the source file (§162). Its start and its
 * length round separately, so a last span ending on the file's final
 * instant can come out one frame past the end — a frame the file does not
 * have, which an importer may refuse or show as offline. The start is
 * clamped to the file's last frame and the length to what is left after
 * it; the spine offsets stay the running sum of what survived, so a
 * clamped span shortens the timeline by its frame instead of leaving a
 * gap (a spine is sequential, and its `duration` is that sum).
 *
 * Clips: attached to the span containing the start frame (the first when
 * it starts before it, the last when it starts at or after the end), at the
 * span's source start plus the distance into the span. Never split: a clip
 * across a cut keeps its full length (Review Focus 2).
 */
export function kitTimelineFrames(input: KitTimelineInput): KitTimelineFrames {
  const fd = fpsToFrameDuration(input.sequence.fps);
  const { spans: kept } = input;
  const boundary = (i: number): number =>
    framesAt(i < kept.length ? kept[i]!.outIn : kept[kept.length - 1]!.outOut, fd);

  // The file's length in SEQUENCE frames, the unit every span start is in.
  const sourceFrames = framesAt(input.source.durationSec, fd);
  const spans: KitTimelineSpan[] = [];
  // From the first boundary, then the running sum: identical to boundary(i)
  // for every span until one is clamped, since a dropped span has no width.
  let offset = kept.length > 0 ? boundary(0) : 0;
  for (let i = 0; i < kept.length; i++) {
    const start = Math.max(0, Math.min(framesAt(kept[i]!.srcIn, fd), sourceFrames - 1));
    const duration = Math.min(boundary(i + 1) - boundary(i), sourceFrames - start);
    if (duration <= 0) continue;
    spans.push({ offset, start, duration });
    offset += duration;
  }
  // A timeline with nothing on track 1 has nothing to attach a clip to and
  // nothing to edit; an empty project in Resolve would only look like a
  // failed import.
  if (spans.length === 0) throw new Error("kit timeline: no kept span is at least one frame long");

  const clips = input.clips.map((c, clip): KitTimelineClip => {
    const at = framesAt(c.startSec, fd);
    let span = spans.findIndex((s) => at >= s.offset && at < s.offset + s.duration);
    if (span < 0) span = at < spans[0]!.offset ? 0 : spans.length - 1;
    const parent = spans[span]!;
    return {
      clip,
      span,
      offset: parent.start + (at - parent.offset),
      duration: Math.max(1, framesAt(c.lengthSec, fd)),
    };
  });

  return {
    frameDuration: fd,
    durationFrames: spans.reduce((sum, s) => sum + s.duration, 0),
    spans,
    clips,
  };
}

/**
 * An attribute value: XML-escaped, then every non-ASCII character as a
 * numeric reference, so the file is pure ASCII whatever a take or a scene
 * is called, and no importer's guess at the encoding can mangle a name.
 * URLs arrive percent-encoded already; this is the
 * attribute's encoding on top (two encodings, two owners, as in
 * export-fcpxml.ts).
 */
function attr(s: string): string {
  return esc(s).replace(/[^\x00-\x7f]/gu, (c) => `&#${c.codePointAt(0)!};`);
}

/** The frame sizes whose `FFVideoFormat<height>p<rate>` name is a real preset. */
const PRESET_SIZES: ReadonlySet<string> = new Set(["1920x1080", "1280x720", "3840x2160"]);

/**
 * A `<format>`'s `name`, or null to leave the attribute out (§162). The
 * name is a claim that such a preset exists; `<height>p<rate>` only names
 * one for the standard landscape sizes at an integer rate. A portrait
 * 1080x1920 output would otherwise be called `FFVideoFormat1920p30`, a
 * preset nobody has, and an NTSC rate has no integer to put in it. Resolve
 * reads `frameDuration`, `width` and `height`, so leaving it out loses
 * nothing; the spike's 1080p60 and 1080p30 keep theirs.
 */
function presetName(width: number, height: number, fd: FrameDuration): string | null {
  if (fd.num !== 1 || !PRESET_SIZES.has(`${width}x${height}`)) return null;
  return `FFVideoFormat${height}p${fd.den}`;
}

export function buildFcpxmlKit(input: KitTimelineInput): string {
  const frames = kitTimelineFrames(input);
  const fd = frames.frameDuration;
  const t = (n: number): string => `${n * fd.num}/${fd.den}s`;

  // Ids in the order the spike assigned them (r1 sequence format, r2 source,
  // r3/r4 the clip's format and asset): one `<format>` per distinct rate and
  // size, one `<asset>` per distinct file — a clip placed twice is one asset
  // referenced twice, as in the spike.
  let nextId = 1;
  const formats = new Map<string, { id: string; fd: FrameDuration; width: number; height: number }>();
  const formatFor = (fps: number, width: number, height: number): string => {
    const ffd = fpsToFrameDuration(fps);
    const key = `${ffd.num}/${ffd.den} ${width}x${height}`;
    let f = formats.get(key);
    if (f === undefined) {
      f = { id: `r${nextId++}`, fd: ffd, width, height };
      formats.set(key, f);
    }
    return f.id;
  };
  const assets = new Map<string, { id: string; format: string; media: KitTimelineMedia }>();
  const assetFor = (media: KitTimelineMedia): { id: string; format: string } => {
    let a = assets.get(media.url);
    if (a === undefined) {
      const format = formatFor(media.fps, media.width, media.height);
      a = { id: `r${nextId++}`, format, media };
      assets.set(media.url, a);
    }
    return a;
  };

  const seqFormat = formatFor(input.sequence.fps, input.sequence.width, input.sequence.height);
  const source = assetFor(input.source);
  const clipAssets = input.clips.map((c) => assetFor(c));

  const formatXml = [...formats.values()].map((f) => {
    const name = presetName(f.width, f.height, f.fd);
    return (
      `    <format id="${f.id}"${name === null ? "" : ` name="${name}"`} ` +
      `frameDuration="${f.fd.num}/${f.fd.den}s" width="${f.width}" height="${f.height}"/>`
    );
  });
  const assetXml = [...assets.values()].map(({ id, format, media }) => {
    // The asset's length is in its OWN frames (`137/30s` for a 30 fps clip),
    // while everything placed on the timeline is in sequence frames.
    const own = fpsToFrameDuration(media.fps);
    const audio = media.hasAudio ? ` audioSources="1" audioChannels="2" audioRate="48000"` : "";
    return (
      `    <asset id="${id}" name="${attr(media.name)}" start="0s" ` +
      `duration="${framesAt(media.durationSec, own) * own.num}/${own.den}s" hasVideo="1" ` +
      `hasAudio="${media.hasAudio ? 1 : 0}" format="${format}"${audio}>\n` +
      `      <media-rep kind="original-media" src="${attr(media.url)}"/>\n` +
      `    </asset>`
    );
  });

  const spineXml = frames.spans.map((s, i) => {
    const open =
      `            <asset-clip ref="${source.id}" name="span ${i + 1}" offset="${t(s.offset)}" ` +
      `start="${t(s.start)}" duration="${t(s.duration)}" format="${source.format}" tcFormat="NDF"`;
    const lane = frames.clips
      .filter((c) => c.span === i)
      .sort((a, b) => a.offset - b.offset)
      .map((c) => {
        const a = clipAssets[c.clip]!;
        return (
          `              <asset-clip ref="${a.id}" lane="1" name="${attr(input.clips[c.clip]!.name)}" ` +
          `offset="${t(c.offset)}" start="0s" duration="${t(c.duration)}" format="${a.format}" tcFormat="NDF"/>`
        );
      });
    return lane.length === 0 ? `${open}/>` : `${open}>\n${lane.join("\n")}\n            </asset-clip>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${[...formatXml, ...assetXml].join("\n")}
  </resources>
  <library>
    <event name="ossclip kit">
      <project name="${attr(input.name)}">
        <sequence format="${seqFormat}" duration="${t(frames.durationFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${spineXml.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
