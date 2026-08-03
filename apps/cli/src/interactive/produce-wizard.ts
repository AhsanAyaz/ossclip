import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { produceArgv, type ProduceAnswers, type ProduceExtras } from "./produce-argv";
import { assertInteractive, confirm, intro, multiselect, select, text, unwrap } from "./prompts";

/**
 * The produce wizard. Twenty-five flags sorted into three tiers: six always
 * asked, seven behind one "anything else?" multiselect, and twelve that stay
 * flags-only because they are debug or internal surfaces.
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
  { value: "sourceIsEdited", label: "Source already has burned-in text", hint: "--source-is-edited" },
  { value: "llm", label: "Choose the LLM provider", hint: "--llm" },
] as const;

export async function produceWizard(cfg: { speaker?: string } = {}): Promise<string[]> {
  assertInteractive("produce wizard");
  intro("ossclip produce");

  const input = unwrap(
    await text({
      message: "Video file",
      placeholder: "./raw/take1.mp4",
      validate: (v) => {
        if (!v) return "a path is required";
        if (!existsSync(v)) return `no such file: ${v}`;
        if (!statSync(v).isFile()) return `${v} is a directory, not a video file`;
        return undefined;
      },
    }),
  ) as string;

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
      options: [...EXTRAS],
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
    extras.whisperModel = unwrap(
      await select({
        message: "Transcription model",
        initialValue: "small.en",
        options: [
          { value: "base.en", label: "base.en", hint: "fastest, least accurate" },
          { value: "small.en", label: "small.en", hint: "default" },
          { value: "medium.en", label: "medium.en", hint: "slowest, most accurate" },
        ],
      }),
    ) as string;
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
