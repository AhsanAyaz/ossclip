import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod/v4";
import { CleanupLevelSchema, SceneComponentIdSchema } from "@ossclip/core";
import { STUDIO_ENTRY } from "@ossclip/renderer";
import { loadEnvFiles } from "./env";
import { ExportFormatSchema, runAnalyse } from "./analyse";
import { phaseBucketProps } from "./phase-timing";
import { produce } from "./produce";
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
      "deterministically collapse consecutive near-identical sentences, keeping only " +
        "the last complete attempt — the flub the speaker did NOT mark. Off by default",
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
    .option("--no-cover", "skip the cover image written beside the video")
    .option("--cover <path>", "cover image output path (default: <out>.cover.jpg)")
    .option("--open-editor", "open the editor when the run finishes")
    .option(
      "--no-open-editor",
      "don't open the editor, and don't ask (overrides openEditorAfterProduce)",
    )
    .option("--editor-port <n>", "port for the editor started by --open-editor",
      (v) => Number.parseInt(v, 10), 5174)
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
      // Wall clock around produce() only — the editor offer below can sit at
      // an interactive prompt for as long as the user thinks, and think-time
      // would poison the duration metric (FINDINGS §134).
      const startedMs = Date.now();
      try {
        const result = await produce(input, {
          out: opts.out,
          cleanup,
          transcript: opts.transcript,
          render: opts.render,
          mezzanine: opts.mezzanine,
          workdir: opts.workdir,
          sort,
          sortExplicit,
          aspect: opts.aspect === "16:9" ? "16:9" : "9:16",
          noiseDb: opts.noiseDb,
          produce: opts.produce,
          intent: opts.intent,
          provider,
          llmModel: opts.llmModel,
          llmFastModel: opts.llmFastModel,
          speaker: opts.speaker,
          scenes: opts.scenes,
          repair: opts.repair,
          whisperModel: opts.whisperModel,
          whisperLanguage,
          forceComponent,
          // commander gives `--no-cover` as cover:false and `--cover <path>` as a
          // string on the same key.
          sourceIsEdited: opts.sourceIsEdited === true,
          blooperMarker: opts.blooperMarker,
          collapseRetakes: opts.collapseRetakes,
          sourceFit,
          // undefined = "not typed", so produce can let the config decide.
          watermark: opts.watermark,
          // undefined = "not typed" here too — the default (ON) is applied at
          // the pin site, not coerced in transit.
          captions: opts.captions,
          cover: opts.cover !== false,
          coverPath: typeof opts.cover === "string" ? opts.cover : undefined,
          clip: opts.clip,
          clipWindow: opts.clipWindow,
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
          render: opts.render !== false,
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
        await offerEditor(result, { flag: opts.openEditor, port: opts.editorPort });
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
    .command("analyse")
    .alias("analyze")
    .description(
      "analyse a take and export the planned cuts as labelled NLE markers — no render, no LLM " +
        "(FCPXML imports into Resolve and Premiere; review the markers, then cut in your own editor)",
    )
    .argument("<input>", "input video file (or a folder of clips)")
    .option(
      "--format <format>",
      "export format: fcpxml (Premiere) | resolve-edl (Resolve coloured timeline markers — " +
        "its fcpxml import drops markers)",
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
      "also mark consecutive near-identical sentences, keeping only the last complete attempt",
      false,
    )
    .option("--sort <order>", "folder input: clip order, name | mtime", "name")
    .action(async (input: string, opts, command) => {
      const cleanup = CleanupLevelSchema.parse(opts.cleanup);
      // Same parse-don't-coerce guard as --source-fit: a typo'd format must
      // error naming the flag, never silently export a different file.
      const format = ExportFormatSchema.parse(opts.format);
      try {
        const result = await runAnalyse(input, {
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
        telemetry.record("analyse_completed", {
          format,
          cleanup_level: cleanup,
          source_duration_bucket: durationBucket(result.sourceDurationSec),
          markers: result.markerCount,
          kept_pauses: result.pauseCount,
          ...phaseBucketProps(result.phaseTimings),
        });
      } catch (err) {
        // Constructor name only, like produce_failed: messages quote paths.
        telemetry.record("analyse_failed", {
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
      const propsPath = resolve(renderProps);
      const publicDir = opts.videoDir ? resolve(opts.videoDir) : dirname(propsPath);
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
      let target: string | undefined = workdir;
      if (workdir !== undefined) {
        const { probeWorkdir } = await import("./interactive/workdir-probe");
        const { resolveWorkdir, candidateListMessage } = await import("./interactive/resolve-workdir");
        const { isInteractive } = await import("./interactive/tty");
        const { dir, probe } = await probeWorkdir(workdir);
        const resolution = resolveWorkdir(dir, probe);
        if (resolution.kind === "none") throw new Error(resolution.message);
        if (resolution.kind === "choose") {
          if (!isInteractive()) {
            throw new Error(candidateListMessage(dir, resolution.candidates));
          }
          const { pickWorkdir } = await import("./interactive/pick-workdir");
          target = await pickWorkdir(resolution.candidates);
        } else {
          target = resolution.workdir;
          // Say so when the path was not the one typed — a silent redirect
          // leaves the user with the wrong mental model of where things live.
          if (resolution.via === "nested") console.log(`▸ resolved ${workdir} → ${target}`);
        }
      }

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
