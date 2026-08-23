import { basename, dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { saveConfigPatch, type OssclipConfig } from "@ossclip/core";
import { MODELS, bareWhisperModelName, modelImpliedLanguage } from "../setup/manifest";
import { defaultOutPath } from "../produce";
import { expandHome } from "../paths";
import { askInput } from "./ask-input";
import { pickSavePath } from "./pick-save-path";
import { produceArgv, type ProduceAnswers, type ProduceExtras } from "./produce-argv";
import { assertInteractive, confirm, intro, multiselect, select, text, unwrap } from "./prompts";

/**
 * The produce wizard. Forty-one flags (plus the positional input path)
 * sorted into three tiers: six prompts asked directly — the input path, plus
 * five flags (--out, --cleanup, --aspect, --produce, --intent) — eleven
 * behind one "anything else?" multiselect, and the remaining stay flags-only:
 * debug/internal surfaces, replay-only fields, --no-watermark (the
 * multiselect only turns the credit ON; off is already the default),
 * --no-youtube (the same shape: the pack entry only turns it ON),
 * --captions (the mirror case: ON is already the default, so the
 * multiselect entry is the OFF switch and the positive flag exists only for
 * replay pinning), --add-jump-cuts (same mirror: auto already punches, the
 * multiselect entry is the OFF switch, and the force flag exists to beat a
 * future config-off), or
 * (final-review fix wave, Finding 1) --sort. A folder's clip order only means anything once the
 * folder has been enumerated, and that enumeration happens inside
 * `produce()` — after the wizard has already returned argv — so there is
 * nothing for a prompt to offer a choice about beforehand. --sort stays
 * typed-only, same tier as --clip-window below, not a tenth multiselect
 * entry.
 *
 * --clip-window is deliberately NOT offered: --clip runs write it into
 * command.json so the editor's Render replays the same window without an LLM
 * call. A human picking it from a menu is a corrupted replay, not a
 * preference.
 */

const EXTRAS = [
  { value: "graphicsClip", label: "Only the strongest N seconds of a long take", hint: "--clip" },
  { value: "sourceFit", label: "Show the whole frame instead of cropping", hint: "--source-fit contain" },
  { value: "speaker", label: "Say who is on camera", hint: "--speaker" },
  { value: "whisperModel", label: "Pick a transcription model", hint: "--whisper-model" },
  // Retake collapse is deliberately NOT an entry (2026-08-16): it runs
  // automatically with --blooper-marker and never otherwise
  // (inferredRetakesEnabled, produce.ts), and the user asked for it not to
  // be exposed as its own knob — the marker entry above IS the switch.
  { value: "blooperMarker", label: "Cut flubbed takes on a spoken word", hint: "--blooper-marker" },
  { value: "sourceIsEdited", label: "Source already has burned-in text", hint: "--source-is-edited" },
  { value: "captionsOff", label: "Turn the burned-in captions off", hint: "--no-captions" },
  { value: "jumpCutsOff", label: "No punch-in zooms at cuts", hint: "--no-jump-cuts" },
  { value: "watermark", label: 'Credit the tool with a small "made with ossclip"', hint: "--watermark" },
  // The hint says the approval part out loud (thumbnail UX, 2026-08-16):
  // ticking this adds an interactive stop before the render, and a surprise
  // prompt mid-run reads as a hang to someone who didn't expect it.
  {
    value: "youtube",
    label: "YouTube pack: SEO metadata + AI thumbnail",
    hint: "--youtube · you approve the thumbnail concept before render",
  },
  { value: "llm", label: "Choose the LLM provider", hint: "--llm" },
] as const;

/**
 * `produce.ts`'s own §93b guard throws "--clip needs the producer's
 * editorial judgement: add --produce" whenever `--clip` shows up without
 * `--produce`. Offering "Only the strongest N seconds" to someone who just
 * answered "no" to graphics is offering a menu item that is a guaranteed
 * error nine prompts later — so the clip extra is only ever listed once
 * graphics is already on. Exported and kept pure so this can be asserted
 * without a TTY.
 *
 * `watermarkFromConfig` (review, minor a): on a config-on machine the
 * watermark entry sits UNCHECKED while the credit will render anyway —
 * unchecked is "don't emit the flag", not "off", and the multiselect has no
 * way to say the second thing. The honest cheap fix is to say so in the
 * entry's own hint rather than pre-checking it (a pre-check would emit a
 * redundant --watermark and teach a command line longer than the run needs,
 * against produceArgv's default-elision rule).
 */
export function extrasFor(
  graphics: boolean,
  opts: { watermarkFromConfig?: boolean } = {},
): { value: (typeof EXTRAS)[number]["value"]; label: string; hint: string }[] {
  const list = graphics ? [...EXTRAS] : EXTRAS.filter((e) => e.value !== "graphicsClip");
  if (opts.watermarkFromConfig !== true) return [...list];
  return list.map((e) =>
    e.value === "watermark"
      ? { ...e, hint: "already on via your config — unticking does not disable it; --no-watermark does" }
      : e,
  );
}

/**
 * Which follow-up prompts the youtube extra asks, given what the config
 * already supplies — `watermarkFromConfig`'s gating idea applied to the
 * follow-up tier: a question whose answer is already in
 * ~/.ossclip/config.json is noise, not a prompt (the flag still overrides
 * the config for a one-off; that is a typed-flags surface, not a wizard
 * one). `typeof`+trim, not truthiness: config.json is hand-edited and
 * unparsed, and a `"audience": true` typo must mean "still ask", never a
 * skipped question over a bogus value. Pure so the gating matrix is
 * testable without a TTY.
 */
export function youtubeFollowups(cfg: {
  audience?: string;
  portrait?: string;
  thumbnailBrief?: string;
}): Array<"audience" | "portrait" | "brief"> {
  const asks: Array<"audience" | "portrait" | "brief"> = [];
  if (typeof cfg.audience !== "string" || cfg.audience.trim() === "") asks.push("audience");
  if (typeof cfg.portrait !== "string" || cfg.portrait.trim() === "") asks.push("portrait");
  if (typeof cfg.thumbnailBrief !== "string" || cfg.thumbnailBrief.trim() === "") {
    asks.push("brief");
  }
  return asks;
}

/**
 * The config patch a yes to "remember these for future runs?" writes, or
 * null when nothing was freshly typed — null means the offer never appears.
 * Only answers TYPED into this run's follow-ups qualify: a key the config
 * already supplies was never asked (youtubeFollowups gates the prompts on
 * exactly that), and the same gate here keeps a future re-ask from letting a
 * wizard answer silently clobber a hand-edited config.json. Portrait is
 * stored as the expandHome-expanded absolute path — a `~` string in
 * config.json would work today (produce.ts expands the config value too, see
 * its own comment at the thumbnail step), but an absolute path in a
 * hand-edited file is self-documenting about which home it meant. Pure, with
 * `home` injectable like expandHome's own, so the matrix is testable without
 * a TTY or the real homedir.
 *
 * Wizard-only by placement: flag-driven runs never reach this — power users
 * have config, and an interactive prompt at the end of a scripted run would
 * break the script.
 */
export function rememberPatch(
  typed: { audience?: string; portrait?: string; thumbnailBrief?: string },
  cfg: { audience?: string; portrait?: string; thumbnailBrief?: string },
  home?: string,
): Partial<OssclipConfig> | null {
  const asked = new Set(youtubeFollowups(cfg));
  // Same typeof+trim rule as youtubeFollowups: a whitespace answer was
  // already dropped by the prompts, but a durable config write deserves the
  // same parse-don't-coerce guard as the read side.
  const fresh = (v: string | undefined): v is string =>
    typeof v === "string" && v.trim() !== "";
  const patch: Partial<OssclipConfig> = {};
  if (asked.has("audience") && fresh(typed.audience)) patch.audience = typed.audience;
  if (asked.has("portrait") && fresh(typed.portrait)) {
    patch.portrait = resolve(expandHome(typed.portrait, home));
  }
  if (asked.has("brief") && fresh(typed.thumbnailBrief)) {
    patch.thumbnailBrief = typed.thumbnailBrief;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Select value that routes to the free-text model prompt instead of a name. */
export const CUSTOM_MODEL = "__custom__";

// Moved to the setup manifest (its language/URL tables need the same
// stripping); re-exported so this module's callers and tests keep one home.
export { bareWhisperModelName };

/** The three names `ossclip setup` knows how to download, with their hints. */
const CANONICAL_MODELS = [
  { value: "base.en", hint: "fastest, least accurate" },
  { value: "small.en", hint: "default" },
  { value: "medium.en", hint: "slowest, most accurate" },
] as const;

/**
 * modelDir listing → select choices. Pure so the enumeration rules —
 * `ggml-*.bin` stripped to bare names, everything else ignored — are testable
 * without a TTY or a real ~/.ossclip. Exists because the fixed .en-only list
 * made a downloaded fine-tune unpickable from the wizard (Urdu field test
 * 2026-08-05: ggml-medium-urdu.bin was installed and working via
 * `--whisper-model medium-urdu`, and the wizard could not name it).
 */
export function whisperModelChoices(
  modelDirFiles: string[],
): { value: string; label: string; hint: string }[] {
  const installed = new Set<string>();
  for (const f of modelDirFiles) {
    // Bare name is what --whisper-model takes: produce.ts joins it back into
    // `ggml-<name>.bin`, so the round trip is exact by construction.
    const m = /^ggml-(.+)\.bin$/.exec(f);
    if (m?.[1] !== undefined) installed.add(m[1]);
  }
  // Canonicals stay listed whether or not downloaded: produce.ts already
  // errors helpfully (naming the setup/curl fix) on a missing model, so the
  // pick works — but the download should not be a surprise, hence the marker.
  const choices: { value: string; label: string; hint: string }[] = CANONICAL_MODELS.map((c) => ({
    value: c.value,
    label: c.value,
    hint: installed.has(c.value) ? c.hint : `${c.hint} · will need download`,
  }));
  // Curated fine-tunes (a manifest `url` marks one): listed like the
  // canonicals whether or not downloaded — setup can fetch them now, so the
  // wizard must be able to name them (the one-command experience the curated
  // table exists for), with the provenance note as the hint.
  const curated = Object.entries(MODELS).filter(
    ([name, info]) => info.url !== undefined && !CANONICAL_MODELS.some((c) => c.value === name),
  );
  for (const [name, info] of curated) {
    choices.push({
      value: name,
      label: name,
      hint:
        (info.note ?? "curated fine-tune") +
        (installed.has(name) ? "" : " · will need download"),
    });
  }
  const listed = new Set(choices.map((c) => c.value));
  for (const name of [...installed].filter((n) => !listed.has(n)).sort()) {
    choices.push({ value: name, label: name, hint: "installed" });
  }
  choices.push({
    value: CUSTOM_MODEL,
    label: "type a name or absolute path",
    hint: "anything whisper.cpp can load",
  });
  return choices;
}

/**
 * The language follow-up's prefill for a picked model. The curated table's
 * own language wins — `medium-urdu` prefills `ur`, so plain Enter runs the
 * fine-tune with the code it was trained for instead of the `auto` detect
 * gamble. Otherwise the standing heuristic: a non-.en pick is multilingual
 * by construction, so `auto` lets whisper detect; `.en` keeps whisper's en
 * default (empty = no flag, produceArgv's default-elision rule).
 */
export function whisperLanguagePrefill(model: string): string {
  return modelImpliedLanguage(model) ?? (bareWhisperModelName(model).endsWith(".en") ? "" : "auto");
}

export async function produceWizard(
  cfg: {
    speaker?: string;
    modelDir?: string;
    input?: string;
    watermark?: boolean;
    /** Gate the youtube follow-ups (youtubeFollowups): ask only what the
     * config doesn't already answer. */
    audience?: string;
    portrait?: string;
    thumbnailBrief?: string;
  } = {},
): Promise<string[]> {
  assertInteractive("produce wizard");
  intro("ossclip produce");

  // Pre-supplied by bare `ossclip <path>` (0.1.9 first-contact, 2026-08-05):
  // the user already TYPED the input on the command line, and the old flow
  // dropped it and asked again — the re-ask is where "./Anyhropic c Compiler"
  // became "./" (all of ~/Downloads). The router checks existence before the
  // wizard ever opens, so a prefilled path skips the prompt entirely.
  //
  // Everything else now lives in ask-input.ts (§136): suggestions, the native
  // picker, and typing, all converging on one validator.
  const input = cfg.input ?? (await askInput());

  const aspect = unwrap(
    await select({
      message: "Shape",
      initialValue: "9:16",
      options: [
        { value: "9:16", label: "Vertical 9:16", hint: "shorts, reels" },
        { value: "16:9", label: "Landscape 16:9", hint: "1920x1080" },
      ],
    }),
  ) as ProduceAnswers["aspect"];

  const cleanup = unwrap(
    await select({
      message: "How hard should it cut?",
      initialValue: "standard",
      options: [
        { value: "exact", label: "exact", hint: "no cuts at all" },
        { value: "light", label: "light" },
        { value: "standard", label: "standard", hint: "recommended" },
        { value: "aggressive", label: "aggressive" },
      ],
    }),
  ) as ProduceAnswers["cleanup"];

  const graphics = unwrap(
    await confirm({ message: "Plan title cards and graphics with an LLM?", initialValue: false }),
  ) as boolean;

  // Only asked under graphics: the intent feeds the producer brain, which
  // does not run otherwise.
  const intent = graphics
    ? (unwrap(
        await text({
          message: "What is the video about?",
          placeholder: "educational video about agents",
        }),
      ) as string)
    : undefined;

  // Folder walk instead of the raw text prompt (2026-08-16 `~`-path
  // incident, pick-save-path.ts). The default name comes from produce's own
  // `defaultOutPath`, not this file's old duplicate regex, so the fast-path
  // row names exactly the file a flag-less run writes; picking that row
  // returns undefined and the elision rule below emits no --out at all.
  // Resolved first because a typed relative input must anchor the walk (and
  // the default's folder) to cwd, not to wherever `dirname` lands.
  const resolvedInput = resolve(input);
  const out = await pickSavePath({
    startDir: dirname(resolvedInput),
    defaultName: basename(defaultOutPath(resolvedInput)),
  });

  const chosen = unwrap(
    await multiselect({
      message: "Anything else? (space to toggle, enter to accept)",
      options: extrasFor(graphics, { watermarkFromConfig: cfg.watermark === true }),
      required: false,
    }),
  ) as string[];

  const extras: ProduceExtras = {};
  if (chosen.includes("graphicsClip")) {
    extras.clip = Number.parseFloat(
      unwrap(
        await text({
          message: "How many seconds?",
          placeholder: "60",
          validate: (v) => {
            const n = Number.parseFloat(v ?? "");
            // Mirrors the CLI's own §93a guard: a zero or a typo must be
            // rejected here rather than coerced into a NaN-length window.
            return Number.isFinite(n) && n > 0 ? undefined : "a positive number of seconds";
          },
        }),
      ) as string,
    );
  }
  if (chosen.includes("sourceFit")) extras.sourceFit = "contain";
  if (chosen.includes("sourceIsEdited")) extras.sourceIsEdited = true;
  // The entry is the OFF switch (captions default ON — see EXTRAS), so a
  // tick maps to `captions: false` and produceArgv emits `--no-captions`.
  if (chosen.includes("captionsOff")) extras.captions = false;
  // Same OFF-switch shape (the punch defaults ON, face-only): a tick maps
  // to `jumpCuts: false` and produceArgv emits `--no-jump-cuts`.
  if (chosen.includes("jumpCutsOff")) extras.jumpCuts = false;
  if (chosen.includes("watermark")) extras.watermark = true;
  if (chosen.includes("youtube")) {
    extras.youtube = true;
    // Follow-ups under the same extra, like --clip's seconds prompt — but
    // gated on the config (youtubeFollowups): a question whose answer is
    // already in ~/.ossclip/config.json is never re-asked. All three trim,
    // like the language follow-up: a whitespace answer must not become a
    // bogus flag value, and an empty answer means "no flag" (the config, or
    // nothing, decides).
    const followups = youtubeFollowups(cfg);
    if (followups.includes("audience")) {
      const audience = (
        unwrap(
          await text({
            message: "Who is this channel for?",
            placeholder: "junior web devs learning AI tooling",
            defaultValue: "",
          }),
        ) as string
      ).trim();
      if (audience) extras.audience = audience;
    }
    if (followups.includes("portrait")) {
      // The portrait only means anything to the pack's AI thumbnail.
      // Optional — empty skips the flag, and the thumbnail falls back to
      // the frame-grab cover.
      const portrait = (
        unwrap(
          await text({
            message: "Portrait photo for the AI thumbnail (empty = use the frame-grab cover)",
            placeholder: "~/Pictures/me.jpg",
            defaultValue: "",
          }),
        ) as string
      ).trim();
      if (portrait) extras.portrait = portrait;
    }
    if (followups.includes("brief")) {
      const brief = (
        unwrap(
          await text({
            message: "Anything the thumbnail must get right? (optional)",
            placeholder: "always show the terminal, never stock imagery",
            defaultValue: "",
          }),
        ) as string
      ).trim();
      if (brief) extras.thumbnailBrief = brief;
    }
    // Offer to persist the fresh answers (UX completion, 2026-08-17): all
    // three are durable channel facts, and before this the wizard re-asked
    // them every run until the user hand-edited ~/.ossclip/config.json. The
    // write is an ADDITION for the NEXT run (loadConfig picks it up), never a
    // substitute for the flags: this run's argv below still carries the typed
    // values, so the printed command stays replayable on a machine without
    // the config. The decision itself lives in rememberPatch, tested without
    // a TTY — this block is only the I/O around it, offer-editor's split.
    const patch = rememberPatch(
      {
        audience: extras.audience,
        portrait: extras.portrait,
        thumbnailBrief: extras.thumbnailBrief,
      },
      cfg,
    );
    if (patch !== null) {
      const remember = unwrap(
        await confirm({
          message: "Remember these for future runs? (saves to ~/.ossclip/config.json)",
          initialValue: true,
        }),
      ) as boolean;
      if (remember) {
        const path = saveConfigPatch(patch);
        // Say where the answers went — offer-editor's rule: a preference
        // saved silently is one the user cannot find again to take back.
        console.log(`▸ saved ${Object.keys(patch).join(", ")} to ${path}`);
      }
    }
  }
  if (chosen.includes("speaker")) {
    extras.speaker = unwrap(
      await text({
        message: "Who is on camera?",
        placeholder: "Ahsan, host of Code with Ahsan",
        // Prefilled from ~/.ossclip/config.json where set, so this answer
        // persists through the config that already exists.
        initialValue: cfg.speaker ?? "",
      }),
    ) as string;
  }
  if (chosen.includes("whisperModel")) {
    // Enumerated from disk, not hardcoded (Urdu field test 2026-08-05): a
    // fine-tune the user already installed must be pickable here, not
    // flags-only. A missing/unset modelDir just means nothing extra to list.
    const modelFiles =
      cfg.modelDir !== undefined && existsSync(cfg.modelDir) ? readdirSync(cfg.modelDir) : [];
    let model = unwrap(
      await select({
        message: "Transcription model",
        initialValue: "small.en",
        options: whisperModelChoices(modelFiles),
      }),
    ) as string;
    if (model === CUSTOM_MODEL) {
      // Trimmed before the guard: " " passing as truthy would emit a
      // whitespace --whisper-model that produce.ts then fails to resolve.
      model = (
        unwrap(
          await text({
            message: "Model name or absolute path to a ggml .bin",
            placeholder: "medium-urdu",
            validate: (v) => (v?.trim() ? undefined : "a model name or path is required"),
          }),
        ) as string
      ).trim();
    }
    extras.whisperModel = model;
    // Follow-up under the same extra, like --clip's seconds prompt: a language
    // only means anything once a model is being picked, and a multilingual
    // fine-tune silently decodes English without it (Urdu field test
    // 2026-08-05). The prefill (whisperLanguagePrefill) makes plain Enter the
    // safe answer: a curated fine-tune's own language, else `auto` for a
    // non-.en pick. Empty keeps whisper's en default, and produceArgv's
    // default-elision rule then emits no flag at all.
    const lang = (
      unwrap(
        await text({
          message: "Transcription language code (empty = default en)",
          placeholder: "ur",
          initialValue: whisperLanguagePrefill(model),
          defaultValue: "",
        }),
      ) as string
    ).trim(); // a whitespace answer means "default", not a bogus -l " "
    if (lang) extras.whisperLanguage = lang;
  }
  if (chosen.includes("blooperMarker")) {
    extras.blooperMarker = unwrap(
      await text({ message: "Which word marks a flubbed take?", placeholder: "blooper" }),
    ) as string;
  }
  if (chosen.includes("llm")) {
    extras.llm = unwrap(
      await select({
        message: "LLM provider",
        options: [
          // Listed in auto-detection's own order (FINDINGS §132): the menu
          // teaching a different ranking than a bare run uses would be drift.
          { value: "antigravity", label: "antigravity", hint: "your logged-in Google Antigravity (agy), no API charges" },
          { value: "claude-cli", label: "claude-cli", hint: "your logged-in Claude Code, no API charges" },
          { value: "claude", label: "claude", hint: "needs ANTHROPIC_API_KEY" },
          { value: "gemini", label: "gemini", hint: "needs GEMINI_API_KEY" },
          { value: "mock", label: "mock", hint: "no LLM at all" },
        ],
      }),
    ) as ProduceExtras["llm"];
  }

  // LAST, because it decides what happens after every answer above it — and
  // asked at all because until §148 the wizard could not reach --review, so
  // `ossclip` with no arguments, the entry point a first-time user takes,
  // could only render first and offer the editor afterwards. That is the
  // opposite of what --review is for: the render is the expensive step, and
  // reviewing exists so it happens once, on a cut you already agreed with.
  //
  // Leaning to review is the one place a wizard default differs from the
  // CLI's. It costs nothing: produceArgv elides against the CLI default, so
  // choosing to render still teaches `ossclip produce <file>` and choosing to
  // review teaches the flag that did it.
  const review =
    unwrap(
      await select({
        message: "Render now, or review the cut first?",
        initialValue: "review",
        options: [
          {
            value: "review",
            label: "Review the cut first",
            hint: "opens the editor; render from its button",
          },
          { value: "render", label: "Render now", hint: "straight to a finished file" },
        ],
      }),
    ) === "review";

  return produceArgv({
    input,
    aspect,
    cleanup,
    graphics,
    intent,
    // Already `string | undefined`: pickSavePath's use-default row IS the
    // old empty answer — no --out, produce derives its own default.
    out,
    review,
    extras,
  });
}
