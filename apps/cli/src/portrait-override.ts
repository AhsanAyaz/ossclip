import { existsSync } from "node:fs";
import { join } from "node:path";
import { PORTRAIT_MIME_TYPES } from "@ossclip/core";
import { expandHome } from "./paths";

/**
 * The per-project portrait override (editor face swap, 2026-08-17): a
 * `portrait-override.<ext>` file in the workdir that outranks both the
 * `--portrait` flag/pin and the config's `portrait`. One rule, spelled once,
 * shared by produce.ts's resolution, thumbnail-panel.ts's pure matrix and
 * edit.ts's endpoints.
 *
 * Lives in apps/cli rather than core because every consumer is here — core's
 * thumbnailStep receives an already-resolved path — and in its own leaf
 * module rather than produce.ts for the same reason `artifactPath` moved to
 * paths.ts: edit.ts cannot import produce.ts (produce imports edit, and
 * produce's import graph drags the renderer into a deliberately
 * dependency-free server).
 */

export const PORTRAIT_OVERRIDE_BASENAME = "portrait-override";

/** Which portrait a resolution picked — the panel labels the swap state
 * from this, so the vocabulary is part of the contract. */
export type PortraitSource = "override" | "flag" | "config";

/**
 * The workdir's override file, or null when none exists. Extensions are
 * probed in PORTRAIT_MIME_TYPES key order, first hit wins — the POST
 * endpoint enforces at most one override, so two can only mean a hand-copied
 * file, and a deterministic table-order pick beats a readdir-order coin
 * flip. `exists` is injectable so the extension matrix needs no filesystem.
 */
export function portraitOverridePath(
  work: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const ext of Object.keys(PORTRAIT_MIME_TYPES)) {
    const path = join(work, `${PORTRAIT_OVERRIDE_BASENAME}.${ext}`);
    if (exists(path)) return path;
  }
  return null;
}

/**
 * The override's filename extension for an uploaded mime type, or undefined
 * when the type is outside the table the Gemini API accepts. Reverse lookup
 * over PORTRAIT_MIME_TYPES so the two directions can never drift; for
 * `image/jpeg`'s two spellings the first table key (`jpg`) wins.
 */
export function portraitExtensionForMime(mimeType: string): string | undefined {
  return Object.keys(PORTRAIT_MIME_TYPES).find((ext) => PORTRAIT_MIME_TYPES[ext] === mimeType);
}

export interface ResolvedPortrait {
  path: string;
  source: PortraitSource;
}

/**
 * The one portrait-precedence rule: workdir override > flag/pin > config.
 * A per-project expression chosen in the editor must survive CLI re-renders,
 * so the override beats even an explicit `--portrait` — the flag/config
 * portrait is the fallback headshot, and a replay silently reverting the
 * swapped face would undo the one thing the swap exists for.
 *
 * expandHome covers the flag and config paths (the 2026-08-16 tilde
 * incident, paths.ts) but not the override, which is server-built and
 * already absolute. The config side is `typeof`, never truthiness — the
 * `portrait` posture: config.json is hand-edited and unparsed.
 */
export function resolvePortrait(args: {
  overridePath: string | null;
  flagPortrait: string | undefined;
  cfgPortrait: unknown;
  home?: string;
}): ResolvedPortrait | undefined {
  if (args.overridePath !== null) return { path: args.overridePath, source: "override" };
  if (args.flagPortrait !== undefined) {
    return { path: expandHome(args.flagPortrait, args.home), source: "flag" };
  }
  if (typeof args.cfgPortrait === "string") {
    return { path: expandHome(args.cfgPortrait, args.home), source: "config" };
  }
  return undefined;
}
