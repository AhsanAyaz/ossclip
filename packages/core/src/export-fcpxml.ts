import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Production, Segment } from "./schema";

/**
 * FCPXML 1.10 marker export — the file format half of `ossclip analyse`
 * (next-directions §2; design doc 2026-08-12-analyse-fcpxml-export-design.md).
 * Pure by the house split: Production in, XML string out; the CLI owns the
 * file write. The document is a project whose single asset-clip is the
 * ORIGINAL source with one named marker per planned cut — markers, not
 * applied cuts, because an editor wants to REVIEW "dead air here / blooper
 * here" before acting on it, and both Resolve and Premiere read this format.
 *
 * No marker colours, resolved deliberately: stock FCPXML `<marker>` carries
 * no colour attribute, and colour does not reliably survive a Resolve round
 * trip — so the cut REASON travels in the marker name (the report.txt
 * vocabulary), which every importer displays.
 */

/** A frame's duration as an exact rational — FCPXML's own time currency. */
export interface FrameDuration {
  num: number;
  den: number;
}

/**
 * NTSC rates have no integer-denominator form — 29.97 is exactly 30000/1001,
 * and ffprobe reports it as a float that equals neither 29.97 nor the
 * rational. Matched by tolerance for that reason; anything else is treated
 * as the integer rate it rounds to.
 */
const NTSC_RATES: Array<{ fps: number; fd: FrameDuration }> = [
  { fps: 24000 / 1001, fd: { num: 1001, den: 24000 } },
  { fps: 30000 / 1001, fd: { num: 1001, den: 30000 } },
  { fps: 60000 / 1001, fd: { num: 1001, den: 60000 } },
];

export function fpsToFrameDuration(fps: number): FrameDuration {
  for (const { fps: ntsc, fd } of NTSC_RATES) {
    if (Math.abs(fps - ntsc) < 0.01) return fd;
  }
  return { num: 1, den: Math.round(fps) };
}

/**
 * A seconds value as a frame-aligned FCPXML rational (`"53/30s"`). A float
 * like `1.77s` is legal FCPXML but frame-misaligned, and importers round it
 * silently — quantizing here keeps the marker on the frame the report named,
 * with the rounding visible in this codebase instead of implicit in theirs.
 */
export function quantizeToFrame(seconds: number, fd: FrameDuration): string {
  const frames = Math.round((seconds * fd.den) / fd.num);
  return `${frames * fd.num}/${fd.den}s`;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The report.txt line, minus the timestamps the marker position already is. */
function markerName(seg: Segment): string {
  const dur = (seg.srcOut - seg.srcIn).toFixed(2);
  const conf = seg.confidence !== undefined ? ` (conf ${seg.confidence.toFixed(2)})` : "";
  return `${seg.reason ?? "cut"} −${dur}s${conf}`;
}

export function buildFcpxmlMarkers(production: Production): string {
  const { path, probe } = production.source;
  const fd = fpsToFrameDuration(probe.fps);
  const dur = quantizeToFrame(probe.duration, fd);
  const name = basename(path);
  const removals = (production.cutlist ?? []).filter((s) => s.kind === "remove");
  const markers = removals
    .map(
      (s) =>
        `            <marker start="${quantizeToFrame(s.srcIn, fd)}" ` +
        `duration="${fd.num}/${fd.den}s" value="${esc(markerName(s))}"/>`,
    )
    .join("\n");
  // pathToFileURL, not string concat: it percent-encodes the characters a
  // URL cannot carry (spaces, #) while the XML escaping below handles the
  // ones an ATTRIBUTE cannot (&) — two encodings, two owners.
  const srcUrl = esc(pathToFileURL(path).href);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" frameDuration="${fd.num}/${fd.den}s" width="${probe.width}" height="${probe.height}"/>
    <asset id="r2" name="${esc(name)}" start="0/${fd.den}s" duration="${dur}" hasVideo="1" hasAudio="${probe.hasAudio ? 1 : 0}" format="r1">
      <media-rep kind="original-media" src="${srcUrl}"/>
    </asset>
  </resources>
  <library>
    <event name="ossclip">
      <project name="${esc(`${name} — ossclip markers`)}">
        <sequence format="r1" duration="${dur}" tcStart="0/${fd.den}s">
          <spine>
            <asset-clip ref="r2" offset="0/${fd.den}s" name="${esc(name)}" start="0/${fd.den}s" duration="${dur}" format="r1">
${markers ? `${markers}\n` : ""}            </asset-clip>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
