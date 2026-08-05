import { basename } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { produceArgv, type ProduceAnswers, type ProduceExtras } from "./produce-argv";
import { assertInteractive, confirm, intro, multiselect, select, text, unwrap } from "./prompts";

/**
 * The produce wizard. Thirty-two flags (plus the positional input path)
 * sorted into three tiers: six prompts asked directly — the input path, plus
 * five flags (--out, --cleanup, --aspect, --produce, --intent) — nine behind
 * one "anything else?" multiselect, and the remaining stay flags-only:
 * debug/internal surfaces, replay-only fields, --no-watermark (the
 * multiselect only turns the credit ON; off is already the default), or
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
  { value: "blooperMarker", label: "Cut flubbed takes on a spoken word", hint: "--blooper-marker" },
  {
    value: "collapseRetakes",
    label: "Collapse repeated takes automatically",
    hint: "--collapse-retakes",
  },
  { value: "sourceIsEdited", label: "Source already has burned-in text", hint: "--source-is-edited" },
  { value: "watermark", label: 'Credit the tool with a small "made with ossclip"', hint: "--watermark" },
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

/** Select value that routes to the free-text model prompt instead of a name. */
export const CUSTOM_MODEL = "__custom__";

/**
 * A model pick reduced to its bare name: basename, minus the optional ggml-
 * prefix and .bin suffix. Exists because the language prefill classifies on
 * `.endsWith(".en")`, and an absolute path like /x/ggml-small.en.bin ends in
 * ".bin" — an English model would have been prefilled `auto` (review fix,
 * Urdu field test 2026-08-05).
 */
export function bareWhisperModelName(nameOrPath: string): string {
  const base = basename(nameOrPath);
  const m = /^(?:ggml-)?(.+?)(?:\.bin)?$/.exec(base);
  return m?.[1] ?? base;
}

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
  const canonical = new Set<string>(CANONICAL_MODELS.map((c) => c.value));
  for (const name of [...installed].filter((n) => !canonical.has(n)).sort()) {
    choices.push({ value: name, label: name, hint: "installed" });
  }
  choices.push({
    value: CUSTOM_MODEL,
    label: "type a name or absolute path",
    hint: "anything whisper.cpp can load",
  });
  return choices;
}

export async function produceWizard(
  cfg: { speaker?: string; modelDir?: string; input?: string; watermark?: boolean } = {},
): Promise<string[]> {
  assertInteractive("produce wizard");
  intro("ossclip produce");

  // Pre-supplied by bare `ossclip <path>` (0.1.9 first-contact, 2026-08-05):
  // the user already TYPED the input on the command line, and the old flow
  // dropped it and asked again — the re-ask is where "./Anyhropic c Compiler"
  // became "./" (all of ~/Downloads). The router checks existence before the
  // wizard ever opens, so a prefilled path skips the prompt entirely.
  const input =
    cfg.input ??
    (unwrap(
      await text({
        // Finding 1 (final-review fix wave): `ossclip produce <folder>` shipped
        // (folder-input-brief.md) but this prompt still rejected a directory —
        // the wizard was the only way in that couldn't do what the CLI could.
        // A folder is concatenated by name (codepoint order, like `ls`); --sort
        // mtime reorders it but stays a typed flag, not a wizard question (see
        // the file-level comment above for why).
        message: "Video file, or a folder of clips to concatenate (by name; --sort mtime is a typed flag)",
        placeholder: "./raw/take1.mp4",
        validate: (v) => {
          if (!v) return "a path is required";
          if (!existsSync(v)) return `no such path: ${v}`;
          const st = statSync(v);
          if (!st.isFile() && !st.isDirectory()) return `${v} is neither a video file nor a folder`;
          return undefined;
        },
      }),
    ) as string);

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

  const defaultOut = `${basename(input).replace(/\.[^.]+$/, "")}.ossclip.mp4`;
  const out = unwrap(
    await text({ message: "Output file", placeholder: defaultOut, defaultValue: "" }),
  ) as string;

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
  if (chosen.includes("collapseRetakes")) extras.collapseRetakes = true;
  if (chosen.includes("sourceIsEdited")) extras.sourceIsEdited = true;
  if (chosen.includes("watermark")) extras.watermark = true;
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
    // 2026-08-05). A non-.en pick is multilingual by construction, so the
    // prefill makes plain Enter the safe answer — `auto` lets whisper detect.
    // Empty keeps whisper's en default, and produceArgv's default-elision
    // rule then emits no flag at all.
    const lang = (
      unwrap(
        await text({
          message: "Transcription language code (empty = default en)",
          placeholder: "ur",
          initialValue: bareWhisperModelName(model).endsWith(".en") ? "" : "auto",
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
          { value: "claude-cli", label: "claude-cli", hint: "your logged-in Claude Code, no API charges" },
          { value: "claude", label: "claude", hint: "needs ANTHROPIC_API_KEY" },
          { value: "gemini", label: "gemini", hint: "needs GEMINI_API_KEY" },
          { value: "mock", label: "mock", hint: "no LLM at all" },
        ],
      }),
    ) as ProduceExtras["llm"];
  }

  return produceArgv({
    input,
    aspect,
    cleanup,
    graphics,
    intent,
    out: out || undefined,
    extras,
  });
}
