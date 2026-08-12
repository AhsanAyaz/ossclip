import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Production, Segment } from "./schema";

/**
 * Premiere marker export — legacy FCP7 XML, "xmeml" (§142). The field test
 * that shipped fcpxml killed its own premise within the hour: Premiere Pro
 * does NOT import modern FCPXML ("File format not supported"); the format it
 * lists as "Final Cut Pro XML" is the LEGACY xmeml interchange, a different
 * document entirely. So: fcpxml serves actual Final Cut Pro, resolve-edl
 * serves Resolve (whose fcpxml import drops markers), and THIS serves
 * Premiere — an xmeml v4 sequence whose SEQUENCE-level markers carry the cut
 * list onto the timeline ruler after File → Import.
 *
 * Same house split as the other two exporters: Production in, string out.
 */

/**
 * xmeml has no rational time: a rate is an integer `timebase` plus an `ntsc`
 * flag, and every position is a frame count at that timebase. 29.97 is
 * "30 TRUE" — the flag, not the number, is where the 1001 lives.
 */
export function xmemlRate(fps: number): { timebase: number; ntsc: boolean } {
  const rounded = Math.round(fps);
  // The NTSC family sits ~0.1% under its integer; a probe float lands close
  // to the exact rational, never on the integer itself.
  const ntsc = Math.abs(fps - rounded) > 0.001;
  return { timebase: ntsc ? Math.ceil(fps) : rounded, ntsc };
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** ASCII hyphen like the EDL label — xmeml consumers are as old as it is. */
function label(seg: Segment): string {
  const dur = (seg.srcOut - seg.srcIn).toFixed(2);
  const conf = seg.confidence !== undefined ? ` (conf ${seg.confidence.toFixed(2)})` : "";
  return `${seg.reason ?? "cut"} -${dur}s${conf}`;
}

export function buildPremiereXmlMarkers(production: Production): string {
  const { path, probe } = production.source;
  const { timebase, ntsc } = xmemlRate(probe.fps);
  const ntscStr = ntsc ? "TRUE" : "FALSE";
  const toFrames = (sec: number) => Math.round(sec * probe.fps);
  const durFrames = toFrames(probe.duration);
  const name = esc(basename(path));
  const rateXml = (indent: string) =>
    `${indent}<rate>\n${indent}  <timebase>${timebase}</timebase>\n${indent}  <ntsc>${ntscStr}</ntsc>\n${indent}</rate>`;
  // Emitted at BOTH levels, deliberately (field feedback, first real editor,
  // §142). SEQUENCE markers sit at fixed timecode — the moment the editor
  // ripple-deletes their first blooper, every downstream one points at the
  // wrong moment, which is exactly why our field editor went back to manual.
  // CLIP markers are anchored to the clip's MEDIA time, so they ride through
  // razor cuts and ripple deletes and stay on the words they describe. The
  // sequence copies stay too: they are the read-only overview of the
  // untouched take, and the two agree while nothing is edited.
  const markerXml = (indent: string) =>
    (production.cutlist ?? [])
      .filter((s) => s.kind === "remove")
      .map(
        (s) =>
          `${indent}<marker>\n` +
          `${indent}  <name>${esc(label(s))}</name>\n` +
          `${indent}  <comment>ossclip suggested cut — review before applying</comment>\n` +
          `${indent}  <in>${toFrames(s.srcIn)}</in>\n` +
          // -1: a point marker, not a span — a span would render as a region
          // Premiere invites you to drag, which overstates the suggestion.
          `${indent}  <out>-1</out>\n` +
          `${indent}</marker>`,
      )
      .join("\n");
  const markers = markerXml("    ");
  const clipMarkers = markerXml("            ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="ossclip-markers">
    <name>${name} — ossclip markers</name>
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
            <width>${probe.width}</width>
            <height>${probe.height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>
          <clipitem id="ci-1">
            <name>${name}</name>
            <duration>${durFrames}</duration>
${rateXml("            ")}
            <start>0</start>
            <end>${durFrames}</end>
            <in>0</in>
            <out>${durFrames}</out>
            <file id="f-1">
              <name>${name}</name>
              <pathurl>${esc(pathToFileURL(path).href)}</pathurl>
${rateXml("              ")}
              <duration>${durFrames}</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>${probe.width}</width>
                    <height>${probe.height}</height>
                  </samplecharacteristics>
                </video>${probe.hasAudio ? "\n                <audio>\n                  <channelcount>2</channelcount>\n                </audio>" : ""}
              </media>
            </file>
${clipMarkers ? `${clipMarkers}\n` : ""}          </clipitem>
        </track>
      </video>
    </media>
${markers ? `${markers}\n` : ""}  </sequence>
</xmeml>
`;
}
