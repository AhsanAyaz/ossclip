import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import {
  ProductionSchema,
  buildFcpxmlMarkers,
  buildPremiereXmlMarkers,
  buildResolveMarkerEdl,
  type CleanupLevel,
} from "@ossclip/core";
import { produce } from "./produce";
import type { PhaseTimings } from "./phase-timing";

/**
 * `ossclip analyse` (next-directions §2–3; design doc
 * 2026-08-12-analyse-fcpxml-export-design.md): the analyser without the
 * renderer. §140 measured the render at 85% of wall time on two machines —
 * this command is the product of skipping it: the same pipeline up to the
 * cut report (no LLM, no Remotion), plus an export file an editor's own NLE
 * can review. Markers, not applied cuts, by design — see the exporter.
 */

/**
 * zod enum, not a string: a typo'd `--format fcpxmll` must error naming the
 * choice, never fall back to a default that silently writes the wrong file
 * (CLAUDE.md's `--source-fit containn` rule, verbatim).
 *
 * `resolve-edl`, not `edl` (§142): it is Resolve's marker-EDL dialect —
 * markers with colours, for `Timeline → Import → Timeline Markers from EDL`
 * — not a cut EDL. A future cut EDL gets its own name; "edl" meaning either
 * would be a permanent ambiguity. It exists because Resolve's FCPXML import
 * silently drops clip markers (field-verified the day fcpxml shipped);
 * Premiere reads the fcpxml markers fine.
 */
export const ExportFormatSchema = z.enum(["fcpxml", "resolve-edl", "premiere-xml"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/** The FILE extension per format — "demo.resolve-edl" would import nowhere. */
const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  fcpxml: "fcpxml",
  "resolve-edl": "edl",
  "premiere-xml": "xml",
};

/** Same shape as produce's `defaultOutPath`: beside the input, new extension. */
export function defaultExportPath(input: string, format: ExportFormat): string {
  return input.replace(/(\.[^.]+)?$/, `.${FORMAT_EXTENSIONS[format]}`);
}

export interface AnalyseOptions {
  cleanup: CleanupLevel;
  format: ExportFormat;
  out?: string;
  transcript?: string;
  workdir?: string;
  noiseDb?: number;
  whisperModel?: string;
  whisperLanguage?: string;
  blooperMarker?: string;
  collapseRetakes?: boolean;
  sort?: "name" | "mtime";
  sortExplicit?: boolean;
}

export interface AnalyseResult {
  workdir: string;
  outPath: string;
  markerCount: number;
  sourceDurationSec: number;
  phaseTimings: PhaseTimings;
}

/**
 * The I/O glue: run the existing no-render pipeline, read back the
 * `production.json` it wrote, hand it to the pure exporter, write the file.
 * The read-back goes through `ProductionSchema.parse` even though this very
 * run just wrote it — the file is user-visible and hand-editable, and a
 * truncated or tweaked one must error here, not export garbage markers.
 */
export async function runAnalyse(
  inputArg: string,
  opts: AnalyseOptions,
): Promise<AnalyseResult> {
  const result = await produce(inputArg, {
    cleanup: opts.cleanup,
    transcript: opts.transcript,
    render: false,
    mezzanine: false,
    workdir: opts.workdir,
    noiseDb: opts.noiseDb,
    whisperModel: opts.whisperModel,
    whisperLanguage: opts.whisperLanguage,
    blooperMarker: opts.blooperMarker,
    collapseRetakes: opts.collapseRetakes,
    sort: opts.sort,
    sortExplicit: opts.sortExplicit,
    cover: false,
  });
  const production = ProductionSchema.parse(
    JSON.parse(await readFile(join(result.workdir, "production.json"), "utf8")),
  );
  // §142, learned the hard way in one field-test hour: each NLE gets its OWN
  // dialect. Premiere rejects modern fcpxml outright, Resolve's fcpxml import
  // silently drops markers — so fcpxml is for actual Final Cut Pro.
  const content =
    opts.format === "resolve-edl"
      ? buildResolveMarkerEdl(production)
      : opts.format === "premiere-xml"
        ? buildPremiereXmlMarkers(production)
        : buildFcpxmlMarkers(production);
  const markerCount = (production.cutlist ?? []).filter((s) => s.kind === "remove").length;
  const outPath = resolve(opts.out ?? defaultExportPath(resolve(inputArg), opts.format));
  await writeFile(outPath, content);
  const detail =
    opts.format === "resolve-edl"
      ? "in Resolve: Media Pool → right-click your timeline → Timelines → Import → Timeline Markers from EDL"
      : opts.format === "premiere-xml"
        ? "in Premiere: File → Import, pick the .xml, relink media if offline"
        : "for Final Cut Pro; Premiere needs --format premiere-xml, Resolve --format resolve-edl";
  console.log(
    `✓ ${opts.format} → ${outPath} (${markerCount} marker${markerCount === 1 ? "" : "s"} — ${detail})`,
  );
  return {
    workdir: result.workdir,
    outPath,
    markerCount,
    sourceDurationSec: result.sourceDurationSec,
    phaseTimings: result.phaseTimings,
  };
}
