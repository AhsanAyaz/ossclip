import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { keptPauseLabel, keptPauses } from "./export-markers";
import { esc, xmemlRate, xmemlRateXml } from "./export-xmeml-util";
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

/** ASCII hyphen like the EDL label — xmeml consumers are as old as it is. */
function label(seg: Segment): string {
  const dur = (seg.srcOut - seg.srcIn).toFixed(2);
  const conf = seg.confidence !== undefined ? ` (conf ${seg.confidence.toFixed(2)})` : "";
  return `${seg.reason ?? "cut"} -${dur}s${conf}`;
}

export function buildPremiereXmlMarkers(production: Production): string {
  const { path, probe } = production.source;
  const { timebase, ntsc } = xmemlRate(probe.fps);
  const toFrames = (sec: number) => Math.round(sec * probe.fps);
  const durFrames = toFrames(probe.duration);
  const name = esc(basename(path));
  const rateXml = (indent: string) => xmemlRateXml(indent, timebase, ntsc);
  // Emitted at BOTH levels, deliberately (field feedback, first real editor,
  // §142). SEQUENCE markers sit at fixed timecode — the moment the editor
  // ripple-deletes their first blooper, every downstream one points at the
  // wrong moment, which is exactly why our field editor went back to manual.
  // CLIP markers are anchored to the clip's MEDIA time, so they ride through
  // razor cuts and ripple deletes and stay on the words they describe. The
  // sequence copies stay too: they are the read-only overview of the
  // untouched take, and the two agree while nothing is edited.
  // SPANS, not points (§142 round 2). The original -1 (point marker) was a
  // deliberate "a span overstates the suggestion" call — the first real
  // editor reversed it: she needs the cut's END ("the video resumes from
  // here") as much as its start, and a span's edges are both. Kept pauses
  // (export-markers.ts) join the same time-ordered list.
  const markerItems = [
    ...(production.cutlist ?? [])
      .filter((s) => s.kind === "remove")
      .map((s) => ({
        start: s.srcIn,
        end: s.srcOut,
        label: label(s),
        comment: "ossclip suggested cut — review before applying",
      })),
    ...keptPauses(production).map((p) => ({
      start: p.start,
      end: p.end,
      label: keptPauseLabel(p),
      comment: "ossclip detected pause — kept, below the cut bar",
    })),
  ].sort((a, b) => a.start - b.start);
  const markerXml = (indent: string) =>
    markerItems
      .map(
        (m) =>
          `${indent}<marker>\n` +
          `${indent}  <name>${esc(m.label)}</name>\n` +
          `${indent}  <comment>${esc(m.comment)}</comment>\n` +
          `${indent}  <in>${toFrames(m.start)}</in>\n` +
          // At least one frame: a zero-length span is as invisible as the
          // point markers this replaced.
          `${indent}  <out>${Math.max(toFrames(m.start) + 1, toFrames(m.end))}</out>\n` +
          `${indent}</marker>`,
      )
      .join("\n");
  const markers = markerXml("    ");
  const clipMarkers = markerXml("            ");
  // Both clipitems carry both links (xmeml convention): this is what makes
  // Premiere treat V1+A1 as ONE linked clip instead of two strangers —
  // field fix 2: without an audio clipitem at all, the sequence imported
  // silent and the editor had to add and link the audio by hand.
  const links = (indent: string) =>
    !probe.hasAudio
      ? ""
      : `${indent}<link>\n` +
    `${indent}  <linkclipref>ci-1</linkclipref>\n` +
    `${indent}  <mediatype>video</mediatype>\n` +
    `${indent}  <trackindex>1</trackindex>\n` +
    `${indent}  <clipindex>1</clipindex>\n` +
    `${indent}</link>\n` +
    `${indent}<link>\n` +
    `${indent}  <linkclipref>ci-2</linkclipref>\n` +
    `${indent}  <mediatype>audio</mediatype>\n` +
    `${indent}  <trackindex>1</trackindex>\n` +
    `${indent}  <clipindex>1</clipindex>\n` +
    `${indent}</link>`;
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
${clipMarkers ? `${clipMarkers}\n` : ""}${links("            ")}
          </clipitem>
        </track>
      </video>${
        probe.hasAudio
          ? `
      <audio>
        <track>
          <clipitem id="ci-2">
            <name>${name}</name>
            <duration>${durFrames}</duration>
${rateXml("            ")}
            <start>0</start>
            <end>${durFrames}</end>
            <in>0</in>
            <out>${durFrames}</out>
            <file id="f-1"/>
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
${links("            ")}
          </clipitem>
        </track>
      </audio>`
          : ""
      }
    </media>
${markers ? `${markers}\n` : ""}  </sequence>
</xmeml>
`;
}
