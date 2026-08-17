import { THUMBNAIL_MODEL_DEFAULT, thumbnailDecision } from "@ossclip/core";
import { resolvePortrait, type PortraitSource } from "./portrait-override";

/**
 * The editor thumbnail panel's availability decision (2026-08-17), pure so
 * the whole pins × config × env matrix is a table test with no server, no
 * filesystem and no real ~/.ossclip. The I/O half lives in edit.ts's
 * /api/thumbnail handler, which gathers command.json, loadConfig() and the
 * env and hands them here.
 *
 * Resolution reads command.json's recorded args FIRST: produce pins the
 * RESOLVED `--youtube`/`--no-youtube` and `--portrait` into every record
 * (replay-argv.ts's determinism contract), so the pins are the replay truth
 * — what the editor's Render would actually do — and the config is only the
 * fallback for a workdir with no record (or a pre-pin legacy one).
 */

/**
 * The last value following any of `names` in a recorded argv — last wins,
 * commander's own rule, so a typed flag plus a pinned one resolves the way
 * the replay would. `undefined` when no occurrence carries a value.
 */
export function lastFlagValue(
  args: readonly string[],
  names: readonly string[],
): string | undefined {
  for (let i = args.length - 2; i >= 0; i--) {
    if (names.includes(args[i]!)) return args[i + 1];
  }
  return undefined;
}

/**
 * The last of an on/off flag pair in a recorded argv, or `undefined` when
 * neither appears (the config decides). Last wins, as above.
 */
export function lastBoolFlag(
  args: readonly string[],
  on: string,
  off: string,
): boolean | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === on) return true;
    if (args[i] === off) return false;
  }
  return undefined;
}

/** The panel's reason vocabulary — why the controls are absent (unavailable),
 * why nothing shows yet (never-generated), or why the user opted out
 * (skip-file). */
export type ThumbnailPanelReason =
  | "no-youtube"
  | "no-portrait"
  | "no-key"
  | "portrait-missing"
  | "skip-file"
  | "never-generated";

export interface ThumbnailPanelState {
  /** ready = controls shown; skipped = user declined at approval (controls
   * still shown — regenerating replaces the decision); unavailable = the
   * preconditions for generating are missing, reason says which. */
  status: "ready" | "skipped" | "unavailable";
  reason?: ThumbnailPanelReason;
  /** The resolved image model slug, reported so the panel can name it. */
  model: string;
  /** The resolved portrait path, when one resolved — the regenerate
   * endpoint's likeness reference. */
  portraitPath?: string;
  /** Which portrait won (override > flag > config) — the panel's swap strip
   * labels itself from this. Present exactly when portraitPath is. */
  portraitSource?: PortraitSource;
}

export interface ThumbnailPanelInputs {
  /** command.json's recorded args, or null when the workdir has none. */
  commandArgs: readonly string[] | null;
  /** loadConfig()'s relevant keys — hand-edited JSON, validated HERE (the
   * `portrait` posture: `typeof`/`=== true`, never truthiness). */
  cfg: { youtube?: unknown; portrait?: unknown; thumbnailModel?: unknown };
  /** GEMINI_API_KEY present and non-empty — env-only, secrets never in
   * config.json (env.ts rule). */
  hasKey: boolean;
  /** The approved file holds `{skip: true}` — the user declined this one. */
  approvedSkip: boolean;
  /** Whether ANY concept exists (approved or cached) — with hasImage below,
   * distinguishes "ready" from "ready but nothing ever generated". */
  hasConcept: boolean;
  /** Whether a generated thumbnail image exists (dest or workdir cache). */
  hasImage: boolean;
  /** Injected existence check so the matrix needs no filesystem. */
  portraitExists: (path: string) => boolean;
  /** The workdir's portrait-override file when one exists (editor face swap,
   * 2026-08-17) — found by the CALLER via portraitOverridePath, so this
   * matrix stays filesystem-free. When set it outranks the pin AND the
   * config, and it alone satisfies the no-portrait gate: a project whose
   * only portrait is a swapped face must still be able to regenerate. */
  overridePortraitPath?: string;
}

export function thumbnailPanelState(inputs: ThumbnailPanelInputs): ThumbnailPanelState {
  const args = inputs.commandArgs ?? [];
  // resolveYoutube's exact rule (produce.ts), restated rather than imported —
  // edit.ts must not pull produce.ts's import graph (see paths.ts's
  // artifactPath note): pin beats config, and the config side is `=== true`,
  // never truthiness, because a typo'd `"youtube": "no"` must read as off.
  //
  // Existing artifacts beat flag archaeology (field case 2026-08-17): a
  // produce run that CRASHED between the thumbnail step and the command.json
  // write leaves a workdir with a concept + image but no pins — the very
  // first wizard run did exactly that (tilde-path rename crash), and the
  // panel answered "no-youtube" about a thumbnail sitting right there. A
  // concept or image on disk is direct evidence the pack was on.
  const youtube =
    lastBoolFlag(args, "--youtube", "--no-youtube") ??
    (inputs.cfg.youtube === true || inputs.hasConcept || inputs.hasImage);
  // resolvePortrait is the ONE precedence rule (override > flag > config —
  // portrait-override.ts has the why), shared with produce.ts so the panel
  // can never disagree with what a replay would actually prompt with. It
  // also carries produce.ts's expandHome treatment of the flag/config paths
  // — a `~/Pictures/me.jpg` must resolve identically here.
  const resolvedPortrait = resolvePortrait({
    overridePath: inputs.overridePortraitPath ?? null,
    flagPortrait: lastFlagValue(args, ["--portrait"]),
    cfgPortrait: inputs.cfg.portrait,
  });
  const portraitPath = resolvedPortrait?.path;
  const model =
    typeof inputs.cfg.thumbnailModel === "string"
      ? inputs.cfg.thumbnailModel
      : THUMBNAIL_MODEL_DEFAULT;
  const decision = thumbnailDecision(
    youtube,
    portraitPath,
    inputs.hasKey,
    portraitPath !== undefined && inputs.portraitExists(portraitPath),
  );
  const base = {
    model,
    ...(resolvedPortrait !== undefined
      ? { portraitPath: resolvedPortrait.path, portraitSource: resolvedPortrait.source }
      : {}),
  };
  if (decision !== "generate") {
    const reason: ThumbnailPanelReason =
      decision === "skip-no-youtube"
        ? "no-youtube"
        : decision === "skip-no-portrait"
          ? "no-portrait"
          : decision === "skip-no-key"
            ? "no-key"
            : "portrait-missing";
    return { status: "unavailable", reason, ...base };
  }
  // The skip file ranks BELOW unavailability: a decision about a thumbnail
  // that cannot generate anyway would show controls that cannot work.
  if (inputs.approvedSkip) return { status: "skipped", reason: "skip-file", ...base };
  return {
    status: "ready",
    // Ready with nothing on disk: the produce run never reached (or never
    // finished) the thumbnail step. The panel shows empty fields and a
    // placeholder instead of pretending an image exists.
    ...(inputs.hasConcept || inputs.hasImage ? {} : { reason: "never-generated" as const }),
    ...base,
  };
}
