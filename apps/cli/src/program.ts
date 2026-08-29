import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod/v4";
import {
  CleanupLevelSchema,
  COVER_MAX_WORDS,
  RESOLUTION_CHOICES,
  ResolutionChoiceSchema,
  SceneComponentIdSchema,
  SfxLevelSchema,
} from "@ossclip/core";
import { STUDIO_ENTRY } from "@ossclip/renderer";
import { loadEnvFiles } from "./env";
import { ExportFormatSchema, runAnalyze } from "./analyze";
import { expandHome } from "./paths";
import { phaseBucketProps } from "./phase-timing";
import { dictionaryFlag, jumpCutsFlag, produce, reviewFlag, sfxFlag } from "./produce";
import { accountsFlag, atFlag, deliveryFlag, platformsFlag, youtubePrivacyFlag } from "./publish";
// The one interactive import that is STATIC rather than `await import()`: the
// `resetInputSource()` run boundary in `buildProgram` has to run synchronously
// while the program is being built, and `buildProgram` cannot await. The graph
// already loads @ossclip/renderer and @ossclip/scenes eagerly through
// produce.ts, so clack riding along costs ~14ms on a ~320ms startup — cheap
// enough not to trade for a racy fire-and-forget import (§136).
//
// Consequence worth stating for whoever edits ask-input.ts next: this module,
// and everything it imports (picker.ts, prompts.ts → @clack/prompts,
// suggest-inputs.ts), is now EAGER on every ossclip invocation — `--version`
// and `doctor` included. A heavy dependency added there is no longer free.
// Removing this line to "restore laziness" deletes the run boundary with it:
// `input_source` would then report the PREVIOUS run's branch, and the only
// test that notices is the buildProgram case in telemetry.test.ts.
import { inputSourceUsed, resetInputSource } from "./interactive/ask-input";
import { setReplayArgv } from "./replay-argv";
import {
  bootstrapTelemetry,
  durationBucket,
  loadState,
  maybeAskRating,
  saveState,
  telemetryOffReason,
} from "./telemetry";

// Before anything reads a provider key (R16 §77) — including the auto-detect
// order in `defaultProviderName`, which decides which model runs.
const envFiles = loadEnvFiles();

/**
 * `--concurrency <n>` → a positive whole number of browser tabs (§93a: reject
 * rather than coerce, the `--clip` idiom). A typo'd `--concurrency 4x` must
 * not become NaN and reach Remotion as "however many you like" — the flag
 * exists precisely because the automatic count killed a browser (2026-08-19
 * field case; `resolveRenderConcurrency` has it). `Number`, not `parseInt`,
 * so "4.5" and "" are errors rather than a silent 4 and a silent 0.
 *
 * Exported so the rejection matrix is testable without commander's exit
 * behaviour in the way.
 */
export function concurrencyFlag(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(
      `--concurrency wants a positive whole number of browser tabs, got "${v}"`,
    );
  }
  return n;
}

/**
 * `<command> [workdir]` → the workdir the user meant.
 *
 * ONE spelling of the probe → resolve → pick ladder, because `edit` and
 * `cover` both need it and two copies drift: the reported failure it exists
 * for is `ossclip edit <video folder>` when produce wrote into
 * `<video folder>/.ossclip/<name>/`, and a `cover` that resolved differently
 * would rebuild a cover for a run the user is not looking at.
 *
 * `command` is threaded so the no-TTY candidate list names the command that
 * was actually run, not always `edit`.
 *
 * Every import here is dynamic on purpose: the interactive stack is not
 * loaded on invocations that never reach a picker, which is what keeps CLI
 * startup cheap.
 */
async function resolveWorkdirArgument(typed: string, command: string): Promise<string> {
  const { probeWorkdir } = await import("./interactive/workdir-probe");
  const { resolveWorkdir, candidateListMessage } = await import("./interactive/resolve-workdir");
  const { isInteractive } = await import("./interactive/tty");
  const { dir, probe } = await probeWorkdir(typed);
  const resolution = resolveWorkdir(dir, probe);
  if (resolution.kind === "none") throw new Error(resolution.message);
  if (resolution.kind === "choose") {
    if (!isInteractive()) {
      throw new Error(candidateListMessage(dir, resolution.candidates, command));
    }
    const { pickWorkdir } = await import("./interactive/pick-workdir");
    return await pickWorkdir(resolution.candidates);
  }
  // Say so when the path was not the one typed — a silent redirect leaves the
  // user with the wrong mental model of where things live.
  if (resolution.via === "nested") console.log(`▸ resolved ${typed} → ${resolution.workdir}`);
  return resolution.workdir;
}

/**
 * Every command this CLI has, built onto a fresh instance.
 *
 * Exported so the wizard's drift guard (test/produce-argv-roundtrip.test.ts)
 * parses wizard argv against the REAL program. It used to parse against a
 * hand-declared replica of thirteen options, which is exactly how
 * `--whisper-model` gets renamed here, keeps being accepted there, and ships
 * a wizard that teaches a flag the CLI no longer has — the drift the argv
 * architecture was chosen to prevent.
 *
 * Every action closes over the LOCAL instance: the wizard hands its argv back
 * through `program.parseAsync`, and that re-entry has to land on the program
 * that is actually running, not on a module-level one.
 */
export function buildProgram(): Command {
  const program = new Command();

  // §136: the input-source telemetry is module state, so something has to say
  // when a RUN begins. Not the produce action — every wizard route re-enters
  // that same action through `program.parseAsync` (§129), so a reset there
  // fires on the re-entered parse, AFTER `askInput` recorded the branch, and
  // `input_source` would read "argv" for every wizard run: the feature would
  // measure exactly nothing. Nor is the process the boundary — a batch or REPL
  // driver runs produce more than once, and the second run would report the
  // first one's branch. The PROGRAM CONSTRUCTION is the boundary: commander 12
  // keeps option state across parseAsync calls (see the bare-`produce` refusal
  // below), so any batch has to rebuild the program per run anyway, which makes
  // one reset per `buildProgram` exactly one per run in both cases.
  resetInputSource();

  // Before dispatch, so the one-time first-run notice precedes any command's
  // own output. Inert in this repo's tests by construction: while POSTHOG_KEY
  // is the placeholder, bootstrap touches no disk and sends nothing (FINDINGS
  // §134) — which is what lets every test build the real program unmocked.
  const telemetry = bootstrapTelemetry();

  program
    .name("ossclip")
    .description(
      "local-first video producer: cuts silence and fillers, word-timed captions, " +
        "face-aware framing, LLM-planned code-rendered graphics",
    )
    // Read from the manifest, never hardcoded (R22 §113): a literal here said
    // "0.1.0" for every release after it, so `--version` reported the number a
    // developer typed rather than the one npm installed — the exact field a
    // bug report is judged by. npm always packs package.json regardless of
    // `files`, so this resolves in a published install too.
    .version(
      (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version,
    );

  // Bare `ossclip` at a TTY opens the menu. Piped or in CI it prints help,
  // byte for byte what it printed before — a front door must not become a
  // hang for a script.
  //
  // Bare `ossclip <path>` ROUTES (0.1.9 first-contact, 2026-08-05): with no
  // argument declared here, commander's default allow-excess-args silently
  // DROPPED the positional — `ossclip "./Anyhropic c Compiler"` opened the
  // menu as if nothing had been typed, and the user re-answered the wizard's
  // input prompt by hand, wrongly, with all of ~/Downloads. Commander
  // dispatches registered subcommand names before this action ever runs, so
  // `produce`/`edit`/… always win over path interpretation (a folder that
  // happens to be NAMED `doctor` goes to the subcommand — acceptable);
  // anything that lands here is a path or a typo, and a typo must be a loud
  // error naming what was tried, never the menu.
  program
    .argument(
      "[path]",
      "an existing video file or clips folder — shorthand for `ossclip produce <path>`, " +
        "with the wizard asking the remaining questions",
    )
    // Commander 12 allows excess args by default, which is the SECOND half of
    // the field failure (review, Important): the report's path was typed
    // UNQUOTED — `ossclip ./Anyhropic c Compiler` — and with excess args
    // allowed, `c` and `Compiler` would vanish wordlessly the moment
    // `./Anyhropic` happened to exist, producing the wrong scope. An unquoted
    // multi-word path must be a loud error, never a partial run.
    .allowExcessArguments(false)
    .action(async (path: string | undefined) => {
      const { isInteractive } = await import("./interactive/tty");
      if (path !== undefined) {
        if (!existsSync(path)) {
          throw new Error(
            `no such file or directory: ${path}\n` +
              "  bare `ossclip <path>` produces an existing video file or clips folder;\n" +
              "  run `ossclip --help` for the commands.",
          );
        }
        const { renderCommand } = await import("./interactive/render");
        // Both branches hand argv back through `program.parseAsync` — the same
        // re-entry shape as the wizard paths below, for the same reason: the
        // zod checks in the produce action must run on this input exactly as
        // they do on a typed command line.
        if (!isInteractive()) {
          // No TTY means no wizard for the remaining questions, but the input
          // IS supplied — a piped `ossclip <path>` is `ossclip produce <path>`.
          const direct = ["produce", path];
          console.log(`\n▸ running:\n    ${renderCommand(direct)}\n`);
          // §129: THIS argv — not process.argv, which still says `ossclip
          // <path>` with no `produce` literal — is the invocation
          // command.json must record for the editor's Render to replay.
          // Every parseAsync re-entry below stashes for the same reason.
          setReplayArgv(direct);
          await program.parseAsync(["node", "ossclip", ...direct]);
          return;
        }
        const { produceWizard } = await import("./interactive/produce-wizard");
        const { loadConfig } = await import("@ossclip/core");
        const cfg = loadConfig();
        // modelDir so the wizard can enumerate installed whisper models
        // (Urdu field test 2026-08-05) — same resolution produce.ts uses.
        // watermark so the extras entry can say when the config already has
        // the credit on (unchecked ≠ off there — review, minor a).
        const argv = await produceWizard({
          speaker: cfg.speaker,
          modelDir: cfg.modelDir,
          input: path,
          watermark: cfg.watermark,
          // The youtube follow-ups skip what the config already supplies
          // (youtubeFollowups) — same reason speaker prefills above.
          audience: cfg.audience,
          portrait: cfg.portrait,
          thumbnailBrief: cfg.thumbnailBrief,
        });
        console.log(`\n▸ running:\n    ${renderCommand(argv)}\n`);
        setReplayArgv(argv); // §129
        await program.parseAsync(["node", "ossclip", ...argv]);
        return;
      }
      if (!isInteractive()) {
        program.outputHelp();
        return;
      }
      const { chooseFromMenu, menuArgv } = await import("./interactive/menu");
      const choice = await chooseFromMenu();
      const direct = menuArgv(choice);
      const { renderCommand } = await import("./interactive/render");
      if (direct !== null) {
        // Echoed for the same reason the wizard echoes: the README promises
        // "every choice prints the equivalent command before it runs, so the
        // menu is also how you learn the flags", and three of the four entries
        // printed nothing. The menu's whole pedagogical point is this line.
        console.log(`\n▸ running:\n    ${renderCommand(direct)}\n`);
        // §129: stashed even for non-produce choices — the invariant is that
        // the stash always mirrors the parse being entered, and only
        // produce's recording ever reads it (consume-on-read keeps a
        // non-produce stash from leaking past this parse).
        setReplayArgv(direct);
        await program.parseAsync(["node", "ossclip", ...direct]);
        return;
      }
      const { produceWizard } = await import("./interactive/produce-wizard");
      const { loadConfig } = await import("@ossclip/core");
      const cfg = loadConfig();
      const argv = await produceWizard({
        speaker: cfg.speaker,
        modelDir: cfg.modelDir,
        watermark: cfg.watermark,
        audience: cfg.audience,
        portrait: cfg.portrait,
        thumbnailBrief: cfg.thumbnailBrief,
      });
      console.log(`\n▸ running:\n    ${renderCommand(argv)}\n`);
      setReplayArgv(argv); // §129
      await program.parseAsync(["node", "ossclip", ...argv]);
    });

  program
    .command("produce")
    .description("transcribe → analyze → cut → captions → render")
    // OPTIONAL so a bare `ossclip produce` at a TTY opens the wizard instead of
    // printing a usage error at somebody who does not yet know the flags. A
    // non-interactive run still gets commander's "missing required argument".
    .argument(
      "[input]",
      "input video file, or a folder of clips to concatenate (by name; see --sort)",
    )
    .option("-o, --out <path>", "output video path (default: <input>.ossclip.mp4)")
    .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
    .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
    .option("--no-render", "stop after writing production.json / render props")
    .option(
      "--no-mezzanine",
      "render straight from the source instead of a dense-keyframe mezzanine " +
        "(also makes the source's folder the render server's public dir)",
    )
    .option("--noise-db <db>", "override the measured silence threshold, e.g. -30", parseFloat)
    .option("--workdir <dir>", "cache/work directory (default: <input dir>/.ossclip)")
    .option(
      "--sort <order>",
      "when <input> is a folder: order its clips before concatenating them — " +
        "name (default, plain codepoint sort, matches `ls`) or mtime (oldest first)",
      "name",
    )
    .option(
      "--aspect <ratio>",
      "output shape: 9:16 (vertical, default) or 16:9 (landscape, 1920x1080)",
      "9:16",
    )
    .option(
      "--resolution <height>",
      "output height: 1080 (default), 1440, 2160, or auto (keep what the source has, " +
        "capped at 2160). Config key: \"resolution\"",
      (v: string) => {
        // Parse, never coerce (CLAUDE.md): a typo'd `--resolution 2610` must
        // not silently render 1080p, and `Number()` on "auto" is NaN.
        const parsed = ResolutionChoiceSchema.safeParse(v.trim());
        if (!parsed.success) {
          throw new InvalidArgumentError(
            `--resolution wants one of ${RESOLUTION_CHOICES.join(", ")}, got "${v}"`,
          );
        }
        return parsed.data;
      },
    )
    .option("--produce", "run the LLM producer brain to plan title cards & graphics", false)
    .option(
      "--clip <seconds>",
      "produce only the strongest ~N-second window of a long take (requires --produce; " +
        "a source already at or under the target is produced whole)",
      (v: string) => {
        // §93a: reject rather than coerce — `--clip 0`, negatives and typos must
        // not silently become "no clip" or NaN-length windows.
        const n = Number.parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new InvalidArgumentError(`--clip wants a positive number of seconds, got "${v}"`);
        }
        return n;
      },
    )
    .option(
      "--clip-window <start:end>",
      "internal: the resolved highlight's word range, recorded into command.json by --clip " +
        "runs so the editor's Render replays the same window without an LLM call",
    )
    .option("--intent <text>", "what the video should be ('educational video about agents…')")
    .option(
      "--sfx",
      // No commander default, the `--watermark` contract: untyped must stay
      // UNDEFINED so the config's `sfx` key can supply it — a `false` default
      // here would make every run's flag beat the config it was written for.
      "place sound effects from the bundled pack (and any pack in ~/.ossclip/sfx) " +
        "on the beats the producer planned. Requires --produce. Config key: \"sfx\"",
    )
    .option(
      "--sfx-level <level>",
      "how much sound design: subtle | normal (default) | meme (unlocks the " +
        "meme-tagged sounds). Implies --sfx. Config key: \"sfxLevel\"",
      (v: string) => {
        // Parse, never coerce (CLAUDE.md): a typo'd `--sfx-level mem` must not
        // silently fall back to `normal` — the level decides whether a vine
        // boom can land in the video at all.
        const parsed = SfxLevelSchema.safeParse(v.trim());
        if (!parsed.success) {
          throw new InvalidArgumentError(
            `--sfx-level wants one of ${SfxLevelSchema.options.join(", ")}, got "${v}"`,
          );
        }
        return parsed.data;
      },
    )
    .option(
      "--llm <provider>",
      // Must state `defaultProviderName`'s real order — the old text omitted
      // the GEMINI-first branch and promised claude-first (field report
      // 2026-08-07); the drift test in llm-help.test.ts pins the agreement.
      // Order changed 2026-08: subscription CLIs beat ambient env keys
      // (FINDINGS §132, antigravity provider).
      "antigravity | claude | claude-cli | gemini | mock. Default: antigravity if the agy " +
        "CLI is installed (your logged-in Google Antigravity, no API charges), else " +
        "claude-cli if the claude CLI is installed (your logged-in Claude Code — Pro/Max " +
        "subscription, no API charges), else gemini if GEMINI_API_KEY is set, else claude " +
        "if ANTHROPIC_API_KEY is set, else claude-cli",
    )
    .option("--llm-model <id>", "override the provider's default model")
    .option(
      "--llm-effort <level>",
      "reasoning effort for the antigravity provider (low|medium|high)",
    )
    .option(
      "--llm-fast-model <id>",
      "model for mechanical calls (repair, scene props); 'same' disables tiering",
    )
    .option(
      "--speaker <who>",
      'who is on camera, e.g. "Ahsan, host of Code with Ahsan" — helps repair recognise mangled names',
    )
    .option("--scenes <path>", "hand-authored scenes JSON (Scene[]) — no LLM in the loop")
    .option(
      "--no-repair",
      "skip the ASR mishearing repair pass (captions then show the raw transcription)",
    )
    .option("--whisper-model <name>", "transcription model for this run, e.g. base.en | small.en | medium.en")
    .option(
      "--whisper-language <code>",
      "transcription language code for a multilingual model, e.g. ur | de | auto (whisper defaults to en)",
    )
    .option(
      "--whisper-translate",
      "translate the speech to ENGLISH captions instead of transcribing it verbatim " +
        "(whisper's -tr; pair with --whisper-language for the SOURCE language)",
      false,
    )
    // COMMA-SEPARATED in one value, not variadic: a variadic option swallows
    // the optional positional [input] whenever the flag precedes the path,
    // and commander offers no way to give the positional priority.
    .option(
      "--dictionary <terms>",
      'comma-separated terms of art the speaker uses, e.g. "JSON, ossclip, Genkit" — ' +
        "biases transcription toward these spellings, vouches them for repair, and " +
        "canonicalizes their casing in captions. Replaces the config's dictionary for " +
        "this run. Needs a whisper-cli new enough to know --prompt (older builds " +
        "reject it with their own error)",
    )
    .option(
      "--force-component <id>",
      "debug: render every graphic with this component (e.g. FlowDiagram) to exercise it on real copy",
    )
    .option(
      "--source-fit <mode>",
      "cover | contain. cover (default) crops the source to fill the vertical " +
        "frame; contain shows the WHOLE frame inset against the backdrop — the " +
        "answer for a landscape take whose content matters beyond the speaker",
      "cover",
    )
    .option(
      "--source-is-edited",
      "the source is already an edited reel with burned-in text — keep ossclip's graphics off it without waiting on detection",
    )
    .option(
      "--blooper-marker <word>",
      "cut the flubbed take whenever you say this word out loud (e.g. blooper): " +
        "removal runs back to the start of the sentence it spoiled. Off unless given",
    )
    .option(
      "--collapse-retakes",
      "legacy no-op: retake collapsing runs automatically with --blooper-marker " +
        "(bloopers and retakes go hand-in-hand — no marker, no retake cuts). " +
        "Kept parseable so recorded command.json replays don't error",
      false,
    )
    // Declared as the same tri-state pair as --open-editor/--no-open-editor:
    // positive first so commander's default stays undefined ("not typed"),
    // which is what lets the config supply the default while a typed
    // --no-watermark still beats a config-on.
    .option(
      "--watermark",
      'credit the tool: a small "made with ossclip" wordmark in the top-left safe area ' +
        "(set it once with watermark: true in ~/.ossclip/config.json)",
    )
    .option("--no-watermark", "no wordmark, even when the config turns it on")
    // Same tri-state shape as --watermark above (positive declared first so
    // commander's default stays undefined = "not typed"): the config's
    // `coverInVideo` key supplies the default (resolveCoverInVideo), and a
    // typed --no-cover-in-video still beats a config-on. A separate key from
    // --cover/--no-cover, which is about WRITING the cover file at all.
    .option(
      "--cover-in-video",
      "overlay the cover image on the video's first frames, for the platforms that ignore " +
        "an uploaded cover and use frame 1. Nothing is inserted — the overlay ends at the " +
        "first spoken word (max 0.5s), so no timing moves " +
        "(set it once with coverInVideo: true in ~/.ossclip/config.json)",
    )
    .option("--no-cover-in-video", "no cover overlay, even when the config turns it on")
    // Same tri-state shape as --watermark above (positive declared first so
    // commander's default stays undefined = "not typed"): the config's
    // `youtube` key supplies the default (resolveYoutube), and a typed
    // --no-youtube still beats a config-on.
    .option(
      "--youtube",
      "write a YouTube pack beside the video: SEO title options, description, hashtags " +
        "and comma-separated tags (<out>.youtube.md), plus an AI thumbnail " +
        "(set it once with youtube: true in ~/.ossclip/config.json)",
    )
    .option("--no-youtube", "no YouTube pack, even when the config turns it on")
    .option(
      "--portrait <path>",
      "your portrait photo, the likeness reference for the --youtube AI thumbnail " +
        "(default: `portrait` in ~/.ossclip/config.json; without one the frame-grab " +
        "cover stands)",
    )
    .option(
      "--audience <text>",
      'who watches the channel, e.g. "junior web devs learning AI tooling" — steers ' +
        "the --youtube pack's titles/tags and the AI thumbnail's concept " +
        "(default: `audience` in ~/.ossclip/config.json)",
    )
    .option(
      "--thumbnail-brief <text>",
      "a standing instruction the AI thumbnail concept must honor, e.g. " +
        '"always show the terminal, never stock imagery" ' +
        "(default: `thumbnailBrief` in ~/.ossclip/config.json)",
    )
    // Same tri-state shape as --watermark above (positive declared first so
    // commander's default stays undefined = "not typed"), though captions
    // have no config key to fill the gap: the tri-state exists so
    // command.json can pin the resolved flag state for replay determinism
    // (recordedProduceArgs) — a bare boolean default would make "not typed"
    // and "typed --captions" indistinguishable to the pin.
    .option(
      "--captions",
      "burned-in captions — already the default; exists so a recorded replay can pin the state",
    )
    .option(
      "--no-captions",
      "no burned-in captions. The CTA keyword styling rides the caption track, so it goes too",
    )
    // A tri-state like --watermark/--captions above, but on TWO commander
    // keys instead of one: the positive is spelled --add-jump-cuts (bare
    // "--jump-cuts" would read as adding CUTS, not the concealing zooms), so
    // commander cannot fold the pair onto one key — --no-jump-cuts creates
    // `jumpCuts` defaulting TRUE, --add-jump-cuts lands on `addJumpCuts`,
    // and the action below reunites them via jumpCutsFlag, reading
    // getOptionValueSource to tell a typed --no-jump-cuts from the default.
    .option(
      "--add-jump-cuts",
      "force the subtle punch-in zooms that conceal jump cuts (already the default). " +
        "The face-only guard still applies — a screen share is never punched, because " +
        "the zoom slides its content — this only beats a config that turns them off",
    )
    .option(
      "--no-jump-cuts",
      "no punch-in zooms at cut boundaries. Narrower than --no-zoom, which kills ALL " +
        "camera motion (the idle push included), not just the cut punch-in",
    )
    .option("--no-cover", "skip the cover image written beside the video")
    .option(
      "--no-zoom",
      "static camera: no idle push, no cut punch-in — for close framings where " +
        "any motion crops the head. Per-scene control stays in the editor (autoZoom)",
    )
    .option("--cover <path>", "cover image output path (default: <out>.cover.jpg)")
    .option(
      "--cover-text-reset",
      "use this run's generated cover headline even if `ossclip cover --text` set one — " +
        "that headline is user-owned and kept by default (deleting cover.json does the same)",
    )
    .option("--open-editor", "open the editor when the run finishes")
    .option(
      "--no-open-editor",
      "don't open the editor, and don't ask (overrides openEditorAfterProduce)",
    )
    // Implies --no-render and forces the editor open — resolved by reviewFlag
    // in the action, where typing --no-render alongside it is agreement and
    // --no-open-editor is the loud contradiction.
    .option(
      "--review",
      "produce without rendering, then open the editor to review the cut before rendering once",
    )
    .option("--editor-port <n>", "port for the editor started by --open-editor",
      (v) => Number.parseInt(v, 10), 5174)
    // No default: undefined = "not typed" is what lets the config's
    // renderConcurrency (and then the cpus-2 guess) supply the value —
    // resolveRenderConcurrency owns the precedence. Recorded runs need nothing
    // special to replay it: command.json stores the argv verbatim
    // (recordedProduceArgs), so a typed --concurrency is already in there, and
    // the editor's Render replays it through THIS parse.
    .option(
      "--concurrency <n>",
      "how many browser tabs render frames in parallel (default: CPU cores - 2, " +
        "floor 2). Turn it DOWN if the render logs 'The browser crashed while " +
        "rendering frame N' — that is the whole browser running out of memory, " +
        "not one frame failing",
      concurrencyFlag,
    )
    .action(async (input: string | undefined, opts, command: Command) => {
      if (input === undefined) {
        // commander 12's parseAsync does not reset option state between calls,
        // so a flag typed alongside a bare `produce` would survive into the
        // wizard's own parse and silently override the answer the user just
        // gave — while `▸ running:` printed a command without it. Refusing is
        // the only shape where the printed command is always the run.
        const typedFlags = command.options.some(
          (o) => command.getOptionValueSource(o.attributeName()) === "cli",
        );
        if (typedFlags) {
          throw new Error(
            "pass the input file when you pass flags — bare `ossclip produce` opens the wizard instead",
          );
        }
        const { isInteractive } = await import("./interactive/tty");
        if (!isInteractive()) {
          throw new Error("missing required argument 'input' — the video file to produce");
        }
        const { produceWizard } = await import("./interactive/produce-wizard");
        const { renderCommand } = await import("./interactive/render");
        const { loadConfig } = await import("@ossclip/core");
        const cfg = loadConfig();
        const argv = await produceWizard({
          speaker: cfg.speaker,
          modelDir: cfg.modelDir,
          watermark: cfg.watermark,
          audience: cfg.audience,
          portrait: cfg.portrait,
          thumbnailBrief: cfg.thumbnailBrief,
        });
        console.log(`\n▸ running:\n    ${renderCommand(argv)}\n`);
        // Re-entering the SAME parse the flags take: the zod checks below run
        // on wizard output exactly as they do on a typed command line.
        setReplayArgv(argv); // §129
        await program.parseAsync(["node", "ossclip", ...argv]);
        return;
      }
      // Say which keys came from a file — never the keys themselves. A run that
      // picks a provider from a `.env` should say where that came from.
      if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
      const cleanup = CleanupLevelSchema.parse(opts.cleanup);
      const provider = opts.llm
        ? z.enum(["antigravity", "claude", "claude-cli", "gemini", "mock"]).parse(opts.llm)
        : undefined;
      // Parsed like --llm above: a typo'd `--llm-effort hgh` must die here
      // naming the allowed values, not silently run at agy's default — the
      // knob exists because of a hang (§143), and a user reaching for it is
      // mid-investigation.
      const llmEffort = opts.llmEffort
        ? z.enum(["low", "medium", "high"]).parse(opts.llmEffort)
        : undefined;
      const forceComponent = opts.forceComponent
        ? SceneComponentIdSchema.parse(opts.forceComponent)
        : undefined;
      // Parsed, not coerced: a typo'd `--source-fit containn` silently falling
      // back to cover is exactly the crop the flag exists to prevent.
      const sourceFit = z.enum(["cover", "contain"]).parse(opts.sourceFit);
      // Same reasoning as --source-fit: a typo'd --sort dat must not silently
      // become the default rather than an error naming the mistake.
      const sort = z.enum(["name", "mtime"]).parse(opts.sort);
      // Final-review fix wave, cheap minor c: distinguishes "the user typed
      // --sort" from "commander's own default filled it in" so produce() can
      // say something when --sort is given for a file, where it does nothing.
      const sortExplicit = command.getOptionValueSource("sort") === "cli";
      // Not an enum — whisper accepts dozens of codes plus "auto" and the list
      // grows with fine-tunes — but an empty string would reach whisper as a
      // bare `-l` and must be an error naming the flag, not a silent English
      // run over an Urdu model (Urdu field test 2026-08-05).
      const whisperLanguage =
        opts.whisperLanguage !== undefined
          ? z.string().trim().min(1, "--whisper-language needs a code, e.g. ur").parse(opts.whisperLanguage)
          : undefined;
      // --add-jump-cuts / --no-jump-cuts land on DIFFERENT commander keys
      // (see the option declarations for why the pair can't share one);
      // jumpCutsFlag reunites them into the tri-state ProduceOptions
      // carries, and throws on the contradiction of typing both — the same
      // loud-error posture as every parse above.
      const jumpCuts = jumpCutsFlag(
        opts.addJumpCuts,
        command.getOptionValueSource("jumpCuts") === "cli",
      );
      // --review resolved BEFORE produce runs: it implies --no-render (typed
      // alongside is agreement) and forces the end-of-run editor open, so the
      // one render happens from the editor's Render button. reviewFlag throws
      // on --no-open-editor, the jumpCutsFlag contradiction posture.
      const { render, openEditor } = reviewFlag(
        opts.review === true,
        opts.render,
        opts.openEditor,
      );
      // Wall clock around produce() only — the editor offer below can sit at
      // an interactive prompt for as long as the user thinks, and think-time
      // would poison the duration metric (FINDINGS §134).
      const startedMs = Date.now();
      try {
        const result = await produce(input, {
          out: opts.out,
          cleanup,
          transcript: opts.transcript,
          // The reviewFlag resolution, not opts.render: --review implies off.
          render,
          // Only phrases the no-render exit ("the editor is opening" instead
          // of the --no-render skip + edit hint) — the render/openEditor
          // consequences are already resolved above.
          review: opts.review === true,
          mezzanine: opts.mezzanine,
          workdir: opts.workdir,
          sort,
          sortExplicit,
          aspect: opts.aspect === "16:9" ? "16:9" : "9:16",
          noiseDb: opts.noiseDb,
          produce: opts.produce,
          intent: opts.intent,
          // `--sfx-level` implies `--sfx` (sfxFlag), resolved HERE so the
          // implication is one pure function rather than a condition produce
          // has to remember. Untyped stays undefined, which is what lets the
          // config's `sfx` key decide (`resolveSfx` at the use site).
          sfx: sfxFlag(opts.sfx, opts.sfxLevel),
          sfxLevel: opts.sfxLevel,
          provider,
          llmModel: opts.llmModel,
          llmFastModel: opts.llmFastModel,
          // The zod-parsed union above; untyped = undefined lets the config's
          // `llmEffort` supply it (resolveLlmEffort at the use site).
          llmEffort,
          speaker: opts.speaker,
          scenes: opts.scenes,
          repair: opts.repair,
          whisperModel: opts.whisperModel,
          whisperLanguage,
          whisperTranslate: opts.whisperTranslate === true,
          // Split/trim/drop-empties (dictionaryFlag) — undefined stays
          // undefined so the config's dictionary can supply the default.
          dictionary: dictionaryFlag(opts.dictionary),
          forceComponent,
          // commander gives `--no-cover` as cover:false and `--cover <path>` as a
          // string on the same key.
          sourceIsEdited: opts.sourceIsEdited === true,
          blooperMarker: opts.blooperMarker,
          collapseRetakes: opts.collapseRetakes,
          sourceFit,
          // commander's --no-zoom default is true; produce only acts on false.
          zoom: opts.zoom,
          // undefined = "not typed", so produce can let the config decide.
          watermark: opts.watermark,
          // The watermark's tri-state again, resolved by resolveCoverInVideo
          // at the use site against the config's `coverInVideo`.
          coverInVideo: opts.coverInVideo,
          // The same tri-state contract as watermark, resolved by
          // resolveYoutube at the use site; --portrait rides along untyped =
          // undefined so the config's path can supply it.
          youtube: opts.youtube,
          portrait: opts.portrait,
          // Typed-beats-config strings like --portrait: untyped = undefined
          // lets the config's `audience`/`thumbnailBrief` supply them; the
          // `typeof === "string"` validation lives at the use site.
          audience: opts.audience,
          thumbnailBrief: opts.thumbnailBrief,
          // undefined = "not typed" here too — the default (ON) is applied at
          // the pin site, not coerced in transit.
          captions: opts.captions,
          // The reunited tri-state (jumpCutsFlag above): undefined = "not
          // typed" = auto, the face-only default.
          jumpCuts,
          cover: opts.cover !== false,
          coverPath: typeof opts.cover === "string" ? opts.cover : undefined,
          // A separate key from --cover: this one is about the TEXT, and the
          // cover/coverPath pair already shares one.
          coverTextReset: opts.coverTextReset === true,
          clip: opts.clip,
          clipWindow: opts.clipWindow,
          // Validated by concurrencyFlag at parse time; undefined = "not
          // typed", which is what lets the config supply it.
          concurrency: opts.concurrency,
          // Same contract: validated by the flag's own parser, and undefined
          // means "not typed" so the config's `resolution` can supply it.
          resolution: opts.resolution,
        });
        // Counts, buckets and names only — the duration crosses the wire as a
        // bucket, and nothing here can carry a path (assertSafeProps enforces
        // it). Inert while POSTHOG_KEY is the placeholder (FINDINGS §134).
        telemetry.record("produce_completed", {
          duration_ms: Date.now() - startedMs,
          llm_provider: result.llmProvider ?? "none",
          produced: opts.produce === true,
          aspect: opts.aspect === "16:9" ? "16:9" : "9:16",
          clip: opts.clip !== undefined,
          // The reviewFlag resolution, spelled `key:` and not shorthand — a
          // --review run must report render: false, and telemetry.test.ts's
          // source-drift scan (§136) only sees `key:`-form props.
          render: render,
          source_duration_bucket: durationBucket(result.sourceDurationSec),
          scenes: result.sceneCount,
          // Per-phase buckets (§140), one `<phase>_bucket` per phase that
          // ran — bucketed in phaseBucketProps, never raw ms. Spread keys are
          // invisible to telemetry.test.ts's source-text drift check, so the
          // §134 pin for these lives in phase-timing.test.ts instead.
          ...phaseBucketProps(result.phaseTimings),
          // Which branch of the input prompt was used — a branch name, never
          // the path itself (§136). The picker exists because typing a path
          // blocked non-technical users; this is how we find out if it helped.
          input_source: inputSourceUsed(),
        });
        if (!telemetry.disabled) {
          telemetry.state.produceCount += 1;
          try {
            saveState(telemetry.state);
          } catch {
            // A read-only home dir must never fail the produce that just
            // succeeded — the rating gate simply advances a run later.
          }
        }
        const { offerEditor } = await import("./interactive/offer-editor");
        // The reviewFlag resolution: --review forces flag=true, and
        // decideOpenEditor already documents that an explicit flag beats
        // `rendered` — the editor reads render-props.json, which a no-render
        // run does write. Reusing this path is what gives --review the edit
        // command's whole posture (resolveEditorPageDir's loud "run pnpm
        // build" degrade, startEditServer, openInBrowser) for free.
        await offerEditor(result, { flag: openEditor, port: opts.editorPort });
        // Deliberately LAST — after the render summary and the editor offer —
        // so the one question ossclip ever asks is the last thing on screen.
        await maybeAskRating(telemetry);
      } catch (err) {
        // The constructor NAME only, never the message: error messages
        // routinely quote the input path, the exact thing §134 forbids.
        telemetry.record("produce_failed", {
          error_class: err instanceof Error ? err.constructor.name : "NonError",
        });
        throw err;
      } finally {
        await telemetry.flush();
      }
    });

  program
    .command("transcribe")
    .description("run the pipeline up to the transcript and cut report, no render")
    .argument("<input>", "input video file")
    .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
    .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
    .option("--noise-db <db>", "override the measured silence threshold, e.g. -30", parseFloat)
    .option("--workdir <dir>", "cache/work directory")
    .option("--whisper-model <name>", "transcription model for this run, e.g. base.en | small.en | medium.en")
    .option(
      "--whisper-language <code>",
      "transcription language code for a multilingual model, e.g. ur | de | auto (whisper defaults to en)",
    )
    .option(
      "--whisper-translate",
      "translate the speech to ENGLISH captions instead of transcribing it verbatim " +
        "(whisper's -tr; pair with --whisper-language for the SOURCE language)",
      false,
    )
    .action(async (input: string, opts) => {
      const cleanup = CleanupLevelSchema.parse(opts.cleanup);
      const result = await produce(input, {
        cleanup,
        transcript: opts.transcript,
        render: false,
        mezzanine: false,
        workdir: opts.workdir,
        noiseDb: opts.noiseDb,
        whisperModel: opts.whisperModel,
        // Same guard as produce's: empty must error, not become a bare `-l`.
        whisperTranslate: opts.whisperTranslate === true,
        whisperLanguage:
          opts.whisperLanguage !== undefined
            ? z.string().trim().min(1, "--whisper-language needs a code, e.g. ur").parse(opts.whisperLanguage)
            : undefined,
      });
      telemetry.record("transcribe_completed", {
        cleanup_level: cleanup,
        source_duration_bucket: durationBucket(result.sourceDurationSec),
      });
      await telemetry.flush();
    });

  program
    // American spelling is primary (house style, 2026-08-12); the British
    // alias stays because a command someone has already learned must not
    // become an "unknown command" over an s/z.
    .command("analyze")
    .alias("analyse")
    .description(
      "analyze a take and export the planned cuts as labelled NLE markers — no render, no LLM " +
        "(FCPXML imports into Resolve and Premiere; review the markers, then cut in your own editor)",
    )
    .argument("<input>", "input video file (or a folder of clips)")
    .option(
      "--format <format>",
      "export format: fcpxml (Final Cut Pro) | premiere-xml (Premiere markers) | " +
        "premiere-project (Premiere, cuts applied + camera keyframes + .srt captions sidecar) | " +
        "resolve-edl (Resolve coloured timeline markers — its fcpxml import drops markers)",
      "fcpxml",
    )
    .option("--out <path>", "export file path (default: <input>.<format>)")
    .option("--cleanup <level>", "exact | light | standard | aggressive", "standard")
    .option("--transcript <path>", "inject a transcript JSON instead of running whisper")
    .option("--noise-db <db>", "override the measured silence threshold, e.g. -30", parseFloat)
    .option("--workdir <dir>", "cache/work directory")
    .option("--whisper-model <name>", "transcription model for this run, e.g. base.en | small.en")
    .option(
      "--whisper-language <code>",
      "transcription language code for a multilingual model, e.g. ur | de | auto (whisper defaults to en)",
    )
    .option(
      "--blooper-marker <word>",
      "mark the flubbed take wherever you say this word out loud (e.g. blooper). Off unless given",
    )
    .option(
      "--collapse-retakes",
      "legacy no-op: retake marking runs automatically with --blooper-marker",
      false,
    )
    .option("--sort <order>", "folder input: clip order, name | mtime", "name")
    .action(async (input: string, opts, command) => {
      const cleanup = CleanupLevelSchema.parse(opts.cleanup);
      // Same parse-don't-coerce guard as --source-fit: a typo'd format must
      // error naming the flag, never silently export a different file.
      const format = ExportFormatSchema.parse(opts.format);
      try {
        const result = await runAnalyze(input, {
          cleanup,
          format,
          out: opts.out,
          transcript: opts.transcript,
          workdir: opts.workdir,
          noiseDb: opts.noiseDb,
          whisperModel: opts.whisperModel,
          whisperLanguage:
            opts.whisperLanguage !== undefined
              ? z.string().trim().min(1, "--whisper-language needs a code, e.g. ur").parse(opts.whisperLanguage)
              : undefined,
          blooperMarker: opts.blooperMarker,
          collapseRetakes: opts.collapseRetakes,
          sort: opts.sort === "mtime" ? "mtime" : "name",
          sortExplicit: command.getOptionValueSource("sort") === "cli",
        });
        // Counts, buckets and names only (§134) — the format is an enum name,
        // never a path; per-phase buckets ride along like produce's.
        telemetry.record("analyze_completed", {
          format,
          cleanup_level: cleanup,
          source_duration_bucket: durationBucket(result.sourceDurationSec),
          markers: result.markerCount,
          kept_pauses: result.pauseCount,
          ...phaseBucketProps(result.phaseTimings),
        });
      } catch (err) {
        // Constructor name only, like produce_failed: messages quote paths.
        telemetry.record("analyze_failed", {
          error_class: err instanceof Error ? err.constructor.name : "NonError",
        });
        throw err;
      } finally {
        await telemetry.flush();
      }
    });

  program
    .command("studio")
    .description("open Remotion Studio on a produced composition (visual debugging)")
    .argument("<renderProps>", "path to a work dir's render-props.json")
    .option("--video-dir <dir>", "directory containing the source video (public dir)")
    .action(async (renderProps: string, opts) => {
      // expandHome before resolve on both user-typed paths (2026-08-16 rule,
      // paths.ts) — a `~/` here must not resolve against cwd.
      const propsPath = resolve(expandHome(renderProps));
      const publicDir = opts.videoDir ? resolve(expandHome(opts.videoDir)) : dirname(propsPath);
      // Resolve Remotion's CLI through module resolution instead of spawning
      // `pnpm` — a global `npm i -g ossclip` has no pnpm and no workspace, and
      // Windows would need the .cmd shim. `@remotion/cli` is a dependency of
      // @ossclip/renderer, so resolving from THERE works in both a clone and a
      // published install, on every OS, run via the node that's running us.
      const { createRequire } = await import("node:module");
      let remotionCliJs: string;
      try {
        const require = createRequire(import.meta.url);
        const rendererDir = dirname(require.resolve("@ossclip/renderer/package.json"));
        const fromRenderer = createRequire(join(rendererDir, "package.json"));
        const cliPkgPath = fromRenderer.resolve("@remotion/cli/package.json");
        const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf8")) as {
          bin: string | Record<string, string>;
        };
        const binRel = typeof cliPkg.bin === "string" ? cliPkg.bin : cliPkg.bin.remotion;
        if (!binRel) throw new Error("no remotion bin entry");
        remotionCliJs = join(dirname(cliPkgPath), binRel);
      } catch {
        throw new Error(
          "couldn't resolve @remotion/cli — in a clone, run `pnpm install` first",
        );
      }
      const child = spawn(
        process.execPath,
        [remotionCliJs, "studio", STUDIO_ENTRY, `--props=${propsPath}`, `--public-dir=${publicDir}`],
        { stdio: "inherit" },
      );
      child.on("error", (e) => {
        console.error(`✗ failed to start Remotion Studio: ${e.message}`);
        process.exit(1);
      });
      child.on("exit", (code) => process.exit(code ?? 0));
    });

  program
    .command("edit")
    .description("open the editing page on a produced workdir")
    // OPTIONAL since R17 §83: with no argument the editor opens on a project
    // picker — recent produce runs plus a folder browser — and the top bar's
    // Open button switches projects without restarting the server.
    .argument("[workdir]", "a work directory containing render-props.json")
    .option("--port <n>", "port to listen on", (v) => Number.parseInt(v, 10), 5174)
    .option("--no-open", "do not open a browser")
    .action(async (workdir: string | undefined, opts) => {
      const { startEditServer, resolveEditorPageDir } = await import("./edit");
      // An npm install ships the page prebuilt (editor-dist/); a clone builds
      // it once with `pnpm build`. A server that starts fine but 404s every
      // page request is the worst version of missing — fail loudly with the
      // fix instead.
      const pageDir = resolveEditorPageDir();
      if (pageDir === null) {
        throw new Error(
          "editor UI isn't built yet — run `pnpm build` " +
            "(or `pnpm --filter @ossclip/editor build`) once, then re-run `ossclip edit`.",
        );
      }

      // With no argument the editor opens on its own project picker (R17 §83).
      // With one, resolve what the user MEANT: `ossclip edit <video folder>`
      // was the reported failure, and produce's output lives one level down.
      const target =
        workdir === undefined ? undefined : await resolveWorkdirArgument(workdir, "edit");

      const server = await startEditServer(target, { port: opts.port, pageDir });
      console.log(`▸ editor at ${server.url}`);
      if (opts.open) {
        const { openInBrowser } = await import("./open");
        openInBrowser(server.url);
      }
      // Fire-and-forget on purpose: the server keeps the process alive for
      // the request's lifetime, and awaiting here would put a metrics POST
      // between the user and their browser opening (FINDINGS §134).
      telemetry.record("editor_opened", {});
      void telemetry.flush();
    });

  program
    .command("cover")
    .description(
      "regenerate a produced workdir's cover image — a new headline or a new frame, " +
        "in seconds, with no video re-render",
    )
    // Optional, like `edit`'s: with no argument this resolves the run under
    // the CURRENT directory, so `cd`-ing to the video's folder is enough.
    .argument("[workdir]", "a work directory, or the folder you produced in")
    .option(
      "--text <headline>",
      `banner headline. Capped at ${COVER_MAX_WORDS} words like produce's (§35), and the ` +
        "trimmed result is printed. Omitted keeps the headline this cover already has",
    )
    .option(
      "--at <seconds>",
      "take the frame from this timestamp. Omitted re-uses the still the last cover was " +
        "built from — the cheap path, which runs no ffmpeg at all",
    )
    .option(
      "--from <video>",
      "which video --at reads: `final` (default) is the FINISHED render, so the frame " +
        "carries the burned-in captions, graphics and watermark; `source` is the original " +
        "take, framed the way produce framed it",
      "final",
    )
    .option(
      "--out <path>",
      "write the JPEG here for THIS run only; a one-off destination that does not change " +
        "where this project's cover lives (that stays where this workdir's last cover went, " +
        "else <out>.cover.jpg)",
    )
    .action(async (workdir: string | undefined, opts) => {
      const { parseCoverFlags, regenerateCover } = await import("./cover");
      // Parsed before anything touches disk: a typo'd `--from finall` must be
      // an error naming the flag, not a cover quietly rebuilt from the wrong
      // video (the --source-fit rule above).
      const flags = parseCoverFlags(opts);

      // The `edit` action's ladder, literally the same one: produce writes
      // into <video's folder>/.ossclip/<name>/, and `ossclip cover
      // ~/Downloads/MyClips` has to find that nested run exactly as `edit`
      // does. With no argument, the current directory is the target.
      const target = await resolveWorkdirArgument(workdir ?? ".", "cover");

      // A thin shell by design: every decision lives in regenerateCover, so
      // the editor's /api/cover/regenerate is the same code and not a second
      // spelling of it.
      await regenerateCover(target, {
        text: flags.text,
        atSec: flags.atSec,
        from: flags.from,
        // Raw: `coverDestination` owns the tilde expansion and the cwd
        // anchor, so there is one site applying `expandHome` to the user half.
        outPath: flags.outPath,
      });
    });

  program
    .command("publish")
    .description(
      "push the finished render to your social accounts through your own self-hosted " +
        "Postiz instance — now, or scheduled with --at",
    )
    // Optional like `edit`'s and `cover`'s: no argument resolves the run
    // under the CURRENT directory.
    .argument("[workdir]", "a work directory, or the folder you produced in")
    .option(
      "--at <iso>",
      "schedule instead of publishing now — an ISO-8601 time in the future " +
        "(e.g. 2026-09-01T08:00:00+02:00)",
      // Wrapped: commander's parseArg passes (value, previous), and atFlag's
      // second parameter is its injectable clock — not a place for `previous`.
      (v: string) => atFlag(v),
    )
    .option(
      "--platforms <list>",
      "only these platforms, comma-separated (linkedin,instagram,tiktok,x,facebook,youtube)",
      platformsFlag,
    )
    .option("--accounts <ids>", "explicit Postiz integration ids, comma-separated (the no-TTY path)", accountsFlag)
    .option("--all", "every connected account (after --platforms, when both are given)", false)
    .option("--dry-run", "print the targets and the exact payload; send nothing", false)
    .option("-y, --yes", "skip the confirmation prompt", false)
    .option("--force", "publish again even though this workdir already has a publish receipt", false)
    .option(
      "--youtube-privacy <level>",
      "YouTube visibility: private (default), unlisted or public",
      youtubePrivacyFlag,
    )
    .option(
      "--delivery <mode>",
      "what to upload — auto: a ≤1080p ~10 Mbps delivery encode, built once and " +
        "cached in the workdir; master: the untouched render",
      deliveryFlag,
      "auto",
    )
    .action(async (workdir: string | undefined, opts) => {
      const { runPublish } = await import("./publish");
      const target = await resolveWorkdirArgument(workdir ?? ".", "publish");
      await runPublish(target, {
        at: opts.at,
        platforms: opts.platforms,
        accounts: opts.accounts,
        all: opts.all,
        dryRun: opts.dryRun,
        yes: opts.yes,
        force: opts.force,
        // Validated by youtubePrivacyFlag at parse time; undefined means the
        // payload's own safe default (private).
        youtubePrivacy: opts.youtubePrivacy,
        delivery: opts.delivery,
      });
      telemetry.record("publish_run", {
        scheduled: opts.at !== undefined,
        dry_run: opts.dryRun === true,
      });
      await telemetry.flush();
    });

  program
    .command("setup")
    .description(
      "install everything ossclip needs (ffmpeg, whisper.cpp, the transcription model) " +
        "into ~/.ossclip — the one-command onboarding on macOS, Linux, and Windows",
    )
    .option("--model <name>", "transcription model to download (default: config, i.e. small.en)")
    .option("--skip-llm", "don't ask about an LLM provider (only --produce needs one)", false)
    .option("--force", "re-download the pieces setup manages, even if present", false)
    .option("-y, --yes", "no questions — accept the plan and skip the provider prompt", false)
    .action(async (opts) => {
      if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
      const { setup } = await import("./setup/setup");
      const summary = await setup({ model: opts.model, skipLlm: opts.skipLlm, force: opts.force, yes: opts.yes });
      telemetry.record("setup_completed", {
        steps_total: summary.stepsTotal,
        steps_satisfied: summary.stepsSatisfied,
        steps_failed: summary.stepsFailed,
      });
      await telemetry.flush();
    });

  program
    .command("doctor")
    .description("check every prerequisite and print the exact fix for anything missing")
    .action(async () => {
      // Env files are loaded at module top (R16 §77) — BEFORE this runs — so a
      // provider key living in a `.env` is visible here, not a false negative.
      if (envFiles.length > 0) console.log(`▸ env: ${envFiles.join(", ")}`);
      const { runDoctor, formatDoctor, realProbes } = await import("./doctor");
      const { resolveEditorPageDir } = await import("./edit");
      const { loadConfig } = await import("@ossclip/core");
      const checks = await runDoctor(loadConfig(), realProbes(resolveEditorPageDir()));
      console.log(formatDoctor(checks));
      const passedCount = checks.filter((c) => c.ok).length;
      telemetry.record("doctor_run", {
        checks_total: checks.length,
        checks_passed: passedCount,
        checks_failed: checks.length - passedCount,
      });
      await telemetry.flush();
      if (checks.some((c) => !c.ok)) process.exit(1);
    });

  program
    .command("telemetry")
    .description("show or change anonymous usage telemetry — on | off | status")
    .argument("[action]", "on | off | status (default: status)")
    .action(async (action: string | undefined) => {
      // Parsed, not coerced (§93a shape): `ossclip telemetry offf` must be a
      // loud error naming the typo, never a silent status print.
      const parsed = z.enum(["on", "off", "status"]).parse(action ?? "status");
      // A fresh load, not the bootstrap instance's state: with the
      // placeholder key bootstrap never reads the file, but an EXPLICIT
      // on/off is the user asking for a persisted preference — it must land
      // in ~/.ossclip/telemetry.json either way, ready for a keyed build.
      const state = loadState();
      if (parsed === "off") {
        state.enabled = false;
        saveState(state);
        console.log("✓ telemetry off — nothing will be sent (saved in ~/.ossclip/telemetry.json)");
        return;
      }
      if (parsed === "on") {
        state.enabled = true;
        saveState(state);
        console.log(
          "✓ telemetry on — anonymous usage events only; see the README's Telemetry section",
        );
        return;
      }
      const reason = telemetryOffReason(process.env, state);
      if (reason === null) {
        console.log("telemetry: enabled (anonymous usage events only)");
      } else {
        // Name the switch that WON, not just the state — three different
        // offs (env, standard env, config) all look identical otherwise, and
        // "why is it still off?" needs the answer.
        const why: Record<typeof reason, string> = {
          "placeholder-key":
            "this build ships without a telemetry key — nothing is ever sent or stored",
          env: `OSSCLIP_TELEMETRY=${process.env.OSSCLIP_TELEMETRY} in the environment`,
          "do-not-track": `DO_NOT_TRACK=${process.env.DO_NOT_TRACK} in the environment`,
          config: "`ossclip telemetry off` (saved in ~/.ossclip/telemetry.json)",
        };
        console.log(`telemetry: disabled — ${why[reason]}`);
      }
      console.log(`anonymous id: ${state.anonymousId}`);
    });

  return program;
}
