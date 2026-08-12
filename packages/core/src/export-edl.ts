import { basename } from "node:path";
import { keptPauseLabel, keptPauses } from "./export-markers";
import type { Production, RemovalReason, Segment } from "./schema";

/**
 * Resolve marker EDL export (§142). The FCPXML exporter's markers are real,
 * but DaVinci Resolve's FCPXML import silently drops clip markers — verified
 * in the field the day FCPXML shipped: timeline imported, 127 markers gone,
 * marker display on. Resolve's dedicated path is `Timeline → Import →
 * Timeline Markers from EDL`, and its format is Resolve's OWN marker-EDL
 * dialect: a CMX3600-shaped event per marker plus a continuation line
 * ` |C:ResolveColor<name> |M:<label> |D:<frames>`.
 *
 * This dialect is also where the §141 colour decision gets un-made for one
 * consumer: FCPXML markers cannot carry colour, but |C: can — so here the
 * cut REASON maps to a colour as well as living in the label.
 */

/**
 * Reason → Resolve marker colour. Names must be from Resolve's fixed
 * View → Show Markers list (verified against Resolve 20); an unknown name
 * imports as the default colour rather than erroring, but stay exact anyway.
 */
const REASON_COLOURS: Record<RemovalReason, string> = {
  silence: "Blue",
  pause: "Sky",
  filler: "Yellow",
  retake: "Red",
  user: "Green",
  clip: "Purple",
};

/** Non-drop hh:mm:ss:ff at an integer frame rate. */
export function framesToTimecode(frames: number, fps: number): string {
  const ff = frames % fps;
  const totalSec = Math.floor(frames / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/**
 * ASCII on purpose, unlike the report and the FCPXML labels: EDL is a
 * fixed-width 1970s interchange format and the true minus sign (U+2212) is
 * exactly the kind of byte that a strict parser turns into a silently
 * skipped line. Pipes are stripped because ` |` is the field separator.
 */
function label(seg: Segment): string {
  const dur = (seg.srcOut - seg.srcIn).toFixed(2);
  const conf = seg.confidence !== undefined ? ` (conf ${seg.confidence.toFixed(2)})` : "";
  return `${seg.reason ?? "cut"} -${dur}s${conf}`.replaceAll("|", "/");
}

export function buildResolveMarkerEdl(production: Production): string {
  const { path, probe } = production.source;
  const fps = Math.round(probe.fps);
  // SPANS, not 1-frame points (§142 round 2): |D: carries the whole
  // suggested cut in frames, so Resolve draws the marker across the region —
  // the field editor needs where content RESUMES as much as where the cut
  // starts. Kept pauses (export-markers.ts) join the list in Lavender, a
  // colour no cut reason uses, so suggestion and information stay distinct.
  const items = [
    ...(production.cutlist ?? [])
      .filter((s) => s.kind === "remove")
      .map((s) => ({
        start: s.srcIn,
        end: s.srcOut,
        colour: REASON_COLOURS[s.reason ?? "user"] ?? "Green",
        label: label(s),
      })),
    ...keptPauses(production).map((p) => ({
      start: p.start,
      end: p.end,
      colour: "Lavender",
      label: keptPauseLabel(p).replaceAll("|", "/"),
    })),
  ].sort((a, b) => a.start - b.start);
  const lines: string[] = [
    `TITLE: ${basename(path)} — ossclip markers`,
    "FCM: NON-DROP FRAME",
    "",
  ];
  items.forEach((m, i) => {
    const inFrames = Math.round(m.start * fps);
    // At least one frame — a zero-length marker is invisible.
    const durFrames = Math.max(1, Math.round(m.end * fps) - inFrames);
    const tcIn = framesToTimecode(inFrames, fps);
    const tcOut = framesToTimecode(inFrames + durFrames, fps);
    // Record TC = source TC: the FCPXML timeline this rides on starts at
    // 00:00:00:00 (tcStart 0), so the marker lands at the source position.
    const num = String(i + 1).padStart(3, "0");
    lines.push(`${num}  001      V     C        ${tcIn} ${tcOut} ${tcIn} ${tcOut}  `);
    lines.push(` |C:ResolveColor${m.colour} |M:${m.label} |D:${durFrames}`);
    lines.push("");
  });
  return `${lines.join("\n")}\n`;
}
