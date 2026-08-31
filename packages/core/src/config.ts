import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPrice } from "./producer/usage";
import type { Theme } from "./scene-schema";

/** Whether a finished `produce` offers to open the editor. */
export type OpenEditorPref = "ask" | "always" | "never";

export interface OssclipConfig {
  ffmpegPath: string;
  ffprobePath: string;
  whisperPath: string;
  modelDir: string;
  model: string;
  /**
   * Model for mechanical LLM calls (repair, scene props) — the editorial beat
   * sheet always uses the main model. "same" disables tiering (FINDINGS §37).
   */
  fastModel?: string;
  /**
   * Reasoning effort for the antigravity provider — low | medium | high,
   * agy's own `--effort` vocabulary. Consumed ONLY by antigravity today
   * (§143: exposed after the hang incident — the knob existed and we passed
   * nothing); every other provider ignores it. `--llm-effort` wins over this
   * per run. File-only like `dictionary`; validated at the consumer
   * (`resolveLlmEffort` in produce.ts), so a hand-edited `"max"` is one
   * warning and an ignored key, never a coerced effort level.
   */
  llmEffort?: string;
  /**
   * Download URLs for models the ggerganov mirror doesn't host, keyed by the
   * bare model name — a user's own fine-tune needs one line:
   * `"modelSources": {"my-model": "https://…/ggml-my-model.bin"}`. Wins over
   * the curated table and the default mirror (`modelUrl` in the CLI's setup
   * manifest). File-only like `dictionary`; validated at the consumer
   * (`validModelSources`), so a hand-edited non-record is one warning and an
   * ignored key, never a crash or a coerced URL.
   */
  modelSources?: Record<string, string>;
  /**
   * Default whisper language code ("ur", "auto", …) — the durable spelling
   * of `--whisper-language` for someone whose recordings are always in one
   * language. The flag beats this per run, and this beats the model table's
   * implied language. File-only like `audience`; validated at the consumer
   * (`resolveWhisperLanguage` in produce.ts), never coerced.
   */
  language?: string;
  /**
   * Who is in the video — "Ahsan, host of the Code with Ahsan channel".
   * Lets the repair pass recognise a mangled proper noun instead of inventing
   * a plausible one, and stops grounding flagging the speaker's own name.
   */
  speaker?: string;
  /**
   * What a finished produce run does about the editor: ask (default), always
   * open, or never mention it. Written by the post-produce prompt when the
   * user picks one of its "stop asking" answers.
   */
  openEditorAfterProduce?: OpenEditorPref;
  /**
   * Opt-in "made with ossclip" wordmark on every produce run, so voluntary
   * attribution is a one-time config write instead of a flag remembered per
   * run. DEFAULT OFF for everyone — a forced watermark on an open-source
   * tool reads as a free-tier limitation, and this is a credit, not one.
   * `--watermark` / `--no-watermark` win over this per run.
   */
  watermark?: boolean;
  /**
   * Overlay the cover image on the opening frames of every produce run, for
   * the platforms that ignore an uploaded cover and use frame 1. DEFAULT OFF:
   * the overlay costs the first fraction of the hook, so it is a choice about
   * where you publish, not a default anyone should inherit.
   * `--cover-in-video` / `--no-cover-in-video` win over this per run
   * (`resolveCoverInVideo`), the `watermark` contract exactly.
   */
  coverInVideo?: boolean;
  /**
   * Place sound effects on every produce run (`--sfx`), so a creator who
   * always wants sound design writes it once instead of typing the flag.
   * DEFAULT OFF: effects are an editorial choice, and inheriting them
   * silently would change how every existing project sounds. `--sfx` wins
   * per run (`resolveSfx`, the `watermark` contract).
   */
  sfx?: boolean;
  /**
   * How much sound design `--sfx` places: "subtle" | "normal" (the default) |
   * "meme". File-only, the `resolution` posture: validated where it is USED
   * (`resolveSfxLevel` in produce.ts), so a hand-edited "loud" earns one
   * warning and `normal` rather than a coerced level — and never `meme`,
   * which is the one that unlocks the meme-tagged sounds.
   */
  sfxLevel?: string;
  /**
   * Whether the bundled starter pack feeds the sound-effect menu. DEFAULT ON —
   * it is the whole library for anyone who never wrote a pack. Set `false` and
   * only `~/.ossclip/sfx` is loaded, which is the ask of someone whose own pack
   * overrides a few stock ids and who wants the REST of them (pop, click,
   * riser-short…) out of the model's menu entirely — overriding ids one at a
   * time cannot do that.
   *
   * Config-level on purpose, with no CLI flag: which packs you own is a
   * property of the machine, not of a run. File-only, the `sfxLevel` posture:
   * validated where it is USED (`resolveSfxBundledPack`, next to the loader in
   * sfx-pack.ts, because the edit server needs the same answer), so a
   * hand-edited `"no"` earns one warning and the bundled pack, never a coerced
   * exclusion.
   */
  sfxBundledPack?: boolean;
  /**
   * Terms of art the speaker uses — "JSON", "ossclip", "Genkit" — biasing
   * transcription (whisper `--prompt`), vouching repair corrections, and
   * canonicalizing caption casing on every run (F4, 2026-08-16: "Jason" for
   * JSON). `--dictionary` on a run wholesale replaces this, never merges.
   * File-only like `watermark`; validated at the consumer
   * (`validDictionary` in produce.ts), so a hand-edited non-array is one
   * warning and an ignored key, never a crash or a coerced term.
   */
  dictionary?: string[];
  /**
   * Global base-theme overrides — caption/graphic colors and fonts applied to
   * every run (F6, 2026-08-16). Partial on purpose: set `accent` alone and
   * every other token keeps its default. Precedence per run:
   * overrides.json (the editor's per-project doc) > this > defaultTheme.
   * File-only; validated at the consumer (`configuredBaseTheme` in
   * produce.ts) all-or-nothing, so one malformed key voids the whole theme
   * with a warning instead of silently half-applying.
   */
  theme?: Partial<Theme>;
  /**
   * Color grade applied to every produce run — the `ColorGradeSchema` shape
   * (`{"preset": "talking-head"}` or `{"lut": "kodak.cube"}`, plus optional
   * intensity/exposure/temperature/saturation/contrast tweaks), for a channel
   * whose look is a standing decision rather than a per-run flag.
   * `--color-grade` / `--no-color-grade` win over this per run, and an
   * overrides.json `colorGrade` beats both (`resolveProductionColorGrade` in
   * produce.ts). File-only, the `theme` posture: a structured value from
   * hand-edited JSON, validated where it is USED (via core's
   * `resolveColorGrade`), so a malformed grade or unknown preset earns one
   * warning naming the source and an ungraded run, never a coerced look.
   * Typed `unknown` deliberately — the type promising `ColorGrade` here would
   * imply a parse `loadConfig` never performs.
   */
  colorGrade?: unknown;
  /**
   * Run the `--youtube` pack (SEO metadata + AI thumbnail) on every produce,
   * so the preference is a one-time config write like `watermark`.
   * `--youtube` / `--no-youtube` win over this per run (`resolveYoutube`).
   */
  youtube?: boolean;
  /**
   * Path to the creator's portrait photo, fed to the AI thumbnail as the
   * likeness reference — a path in the config like `browserExecutable`, set
   * once rather than typed per run. `--portrait` wins over this. Existence
   * is checked where the thumbnail is generated, not at load: an absent file
   * there means a loud skip and the frame-grab cover stands.
   */
  portrait?: string;
  /**
   * Who watches the channel — "junior web devs learning AI tooling". Feeds
   * BOTH the `--youtube` pack prompt (titles/tags for the right viewer) and
   * the AI thumbnail's concept call, so it is set once here rather than
   * retyped per run. `--audience` wins over this per run. File-only like
   * `portrait`; validated at the consumer (`typeof === "string"` at use),
   * never coerced.
   */
  audience?: string;
  /**
   * The durable thumbnail steer — "always show the terminal, never stock
   * imagery". Fed to the AI thumbnail's concept call as a must-honor creator
   * brief on every run. `--thumbnail-brief` wins over this per run.
   * File-only like `audience`, validated the same way at use.
   */
  thumbnailBrief?: string;
  /**
   * Image model for the AI thumbnail (Y3). Overrides the built-in default
   * slug; the GEMINI_API_KEY itself stays in the environment — secrets never
   * live in config.json (env.ts's documented rule).
   */
  thumbnailModel?: string;
  browserExecutable?: string;
  /**
   * Browser tabs the render runs in parallel (2026-08-17 render-speed pass).
   * Unset means cpus-2 with a floor of 2 — the render is decode-bound, and
   * two cores stay free for OffthreadVideo's ffmpeg extract workers. File-only
   * like `dictionary`; validated at the consumer (`resolveRenderConcurrency`
   * in produce.ts) as a positive integer, so a hand-edited `"4"` or `-1` is
   * one warning and the default, never a coerced tab count.
   */
  renderConcurrency?: number;
  /**
   * Base URL of the user's own self-hosted Postiz instance
   * (https://postiz.com), the backend `ossclip publish` posts through —
   * "https://postiz.example.com" or "http://localhost:5000". Non-secret, so
   * it may live here; the API key is `OSSCLIP_POSTIZ_API_KEY` in the
   * ENVIRONMENT only (env.ts's documented rule — secrets never live in
   * config.json). File-only like `audience`; validated at the consumer
   * (`publishConfigured` in the CLI), never coerced.
   */
  postizUrl?: string;
  /**
   * `--resolution`'s default for this machine: "auto" (keep what the source
   * has, capped at 2160), "1080" (the built-in default), "1440" or "2160".
   * File-only, the `watermark` posture: validated where it is USED
   * (`resolveResolution` in produce.ts), so a hand-edited "4k" earns one
   * warning and the 1080 default rather than a coerced render size.
   */
  resolution?: string;
  /**
   * USD per million tokens, keyed by model id or family substring — overrides
   * the built-in assumptions in `producer/usage.ts` so a run's cost line
   * reflects the account's actual rates instead of ours.
   */
  pricing?: Record<string, ModelPrice>;
}

const DEFAULTS: OssclipConfig = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  whisperPath: "whisper-cli",
  modelDir: join(homedir(), ".ossclip", "models"),
  // small.en over base.en: a large accuracy step for accented English at
  // modest cost — base.en turned "code churn" into a company name that then
  // reached the captions and a hook label (FINDINGS §14b).
  model: "small.en",
};

/** Everything ossclip owns on disk lives under here: config.json, models/, bin/, .env. */
export const CONFIG_DIR = join(homedir(), ".ossclip");

export function configFilePath(baseDir: string = CONFIG_DIR): string {
  return join(baseDir, "config.json");
}

/**
 * Merge a patch into `~/.ossclip/config.json`, creating it if needed.
 *
 * Read-merge-write over the RAW file, not a loaded OssclipConfig: users
 * hand-edit this file, and keys the patch doesn't touch (`pricing`,
 * `speaker`, comments-by-convention like `_note`) must survive a
 * `ossclip setup` run untouched.
 */
export function saveConfigPatch(patch: Partial<OssclipConfig>, baseDir: string = CONFIG_DIR): string {
  const path = configFilePath(baseDir);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // absent or unparseable — a fresh object; setup never destroys a broken
    // file silently, so keep a .bak when the file existed but didn't parse
    try {
      const raw = readFileSync(path, "utf8");
      writeFileSync(`${path}.bak`, raw);
    } catch {
      // truly absent — nothing to back up
    }
  }
  mkdirSync(baseDir, { recursive: true });
  const merged = { ...existing, ...patch };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

/**
 * Resolution order per key: env (OSSCLIP_FFMPEG, OSSCLIP_FFPROBE, OSSCLIP_WHISPER,
 * OSSCLIP_MODEL_DIR, OSSCLIP_MODEL, OSSCLIP_BROWSER) → ~/.ossclip/config.json → defaults.
 */
export function loadConfig(): OssclipConfig {
  let fileCfg: Partial<OssclipConfig> = {};
  try {
    fileCfg = JSON.parse(readFileSync(join(homedir(), ".ossclip", "config.json"), "utf8"));
  } catch {
    // no config file — fine
  }
  return resolveConfig(fileCfg, process.env);
}

/**
 * The pure half of `loadConfig` — the file-vs-env-vs-default resolution with
 * no homedir read, so the mapping itself is testable (config.test.ts). Split
 * out after the 2026-08-27 publish E2E: `postizUrl` sat on the TYPE and in
 * the docs but this hand-written mapping never copied it, so publish reported
 * "missing postizUrl" against a config.json that plainly had it — a key that
 * exists only in the type is invisible at runtime, and nothing could say so
 * while the mapping lived behind the filesystem.
 */
export function resolveConfig(
  fileCfg: Partial<OssclipConfig>,
  env: NodeJS.ProcessEnv,
): OssclipConfig {
  return {
    ffmpegPath: env.OSSCLIP_FFMPEG ?? fileCfg.ffmpegPath ?? DEFAULTS.ffmpegPath,
    ffprobePath: env.OSSCLIP_FFPROBE ?? fileCfg.ffprobePath ?? DEFAULTS.ffprobePath,
    whisperPath: env.OSSCLIP_WHISPER ?? fileCfg.whisperPath ?? DEFAULTS.whisperPath,
    modelDir: env.OSSCLIP_MODEL_DIR ?? fileCfg.modelDir ?? DEFAULTS.modelDir,
    model: env.OSSCLIP_MODEL ?? fileCfg.model ?? DEFAULTS.model,
    fastModel: env.OSSCLIP_FAST_MODEL ?? fileCfg.fastModel,
    // File-only, the `dictionary` posture — and deliberately NO env spelling
    // (flag + config are the whole interface): validated where it is USED
    // (`resolveLlmEffort` in produce.ts), so a hand-edited `"max"` earns one
    // warning there and agy's default, never a coerced effort.
    llmEffort: fileCfg.llmEffort,
    speaker: env.OSSCLIP_SPEAKER ?? fileCfg.speaker,
    openEditorAfterProduce: (env.OSSCLIP_OPEN_EDITOR ?? fileCfg.openEditorAfterProduce) as
      | OpenEditorPref
      | undefined,
    browserExecutable: env.OSSCLIP_BROWSER ?? fileCfg.browserExecutable,
    // File-only, like `pricing`: an env spelling would arrive as a string,
    // and "false" is truthy — parse-don't-coerce says no such trap. The
    // strict `=== true` check lives at the consumer (produce's
    // resolveWatermark), so a hand-edited non-boolean stays OFF, the safe
    // default for a credit.
    watermark: fileCfg.watermark,
    // File-only, `watermark`'s posture verbatim: the strict `=== true` lives
    // at the consumer (produce's resolveCoverInVideo), so a hand-edited
    // non-boolean stays OFF — the safe default for something that paints over
    // the first frames of the hook.
    coverInVideo: fileCfg.coverInVideo,
    // File-only, `watermark`'s posture again: the strict `=== true` lives at
    // the consumer (produce's `resolveSfx`) and the level is zod-parsed there
    // (`resolveSfxLevel`), so a hand-edited non-boolean stays OFF and a
    // misspelled level earns a warning and `normal`.
    sfx: fileCfg.sfx,
    sfxLevel: fileCfg.sfxLevel,
    // File-only too, and NO env spelling for the `watermark` reason: "false"
    // arrives truthy from an environment. The typeof check lives at the
    // consumer (`resolveSfxBundledPack` in sfx-pack.ts), where an absent or
    // malformed value keeps the bundled pack — the safe default, since the
    // alternative is a library that may be empty.
    sfxBundledPack: fileCfg.sfxBundledPack,
    // File-only for the same reason as `watermark`: these are structured
    // values a hand-editable JSON file supplies, and parse-don't-coerce says
    // the strict checks live at the consumer — `validDictionary` /
    // `configuredBaseTheme` in produce.ts — where a malformed value earns a
    // warning naming the problem and the safe default, never a coercion.
    dictionary: fileCfg.dictionary,
    theme: fileCfg.theme,
    // File-only, the `theme` posture, and NO env spelling (a grade is a
    // structured object no env var can carry honestly): validated at the
    // consumer (`resolveProductionColorGrade` in produce.ts via
    // `resolveColorGrade`), where a malformed value earns one warning naming
    // the source and an ungraded run — the postizUrl lesson says the mapping
    // must still copy it, or the key is invisible at runtime.
    colorGrade: fileCfg.colorGrade,
    // File-only, the same posture: both are validated where they are USED —
    // `validModelSources` / `resolveWhisperLanguage` — so a hand-edited
    // non-record or non-string earns one warning there, never a coercion.
    modelSources: fileCfg.modelSources,
    language: fileCfg.language,
    // File-only, the `watermark` posture again: `youtube` gets the strict
    // `=== true` check at its consumer (produce's resolveYoutube), and
    // `portrait`/`thumbnailModel` are validated where they are USED — a
    // malformed value earns a loud skip there, never a coercion here.
    youtube: fileCfg.youtube,
    // File-only, the `dictionary` posture: a structured value from hand-edited
    // JSON, validated where it is USED (`resolveRenderConcurrency`) — a
    // malformed count earns one warning there and the cpus-2 default, never a
    // coerced concurrency.
    renderConcurrency: fileCfg.renderConcurrency,
    portrait: fileCfg.portrait,
    audience: fileCfg.audience,
    thumbnailBrief: fileCfg.thumbnailBrief,
    thumbnailModel: fileCfg.thumbnailModel,
    pricing: fileCfg.pricing,
    // File-only, non-secret by declaration (the field's own doc): the API key
    // deliberately lives in the environment (publish.ts's
    // `publishConfigured`), so this is only the instance URL.
    postizUrl: fileCfg.postizUrl,
    resolution: fileCfg.resolution,
  };
}
