import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { CONFIG_DIR } from "@ossclip/core";

/**
 * Anonymous opt-out usage telemetry (FINDINGS §134).
 *
 * The layering follows the house split: everything above the "I/O" divider is
 * pure — testable without a filesystem, a TTY or a network — and the thin I/O
 * below it (state file, PostHog POST, readline) is injectable where a test
 * needs to see through it.
 *
 * Privacy floor, non-negotiable: no event ever carries a file path, a file
 * name, transcript text, `--intent` text, a prompt, or a key. `assertSafeProps`
 * is the drift guard that keeps FUTURE events honest about it, not just the
 * ones written today.
 */

/**
 * The baked-in default is the project's WRITE-ONLY ingest key — public by
 * design (every shipped analytics client carries one; it can only capture,
 * never read), and baked rather than env-read because ossclip is a
 * distributed CLI: an end user who installed from npm has no POSTHOG_API_KEY
 * in their environment, so an env-only key would mean telemetry that never
 * reports from exactly the machines it exists to count (§134). The env var
 * still OVERRIDES the default for development against another project.
 *
 * With the key real, the test suite's hermeticity comes from vitest.config.ts
 * exporting OSSCLIP_TELEMETRY=0 into every test process — see the
 * hermetic-suite tests in telemetry.test.ts. Typed `string`, not the literal,
 * so the `=== POSTHOG_PLACEHOLDER` checks stay ordinary comparisons.
 */
export const POSTHOG_PLACEHOLDER = "phc_REPLACE_ME";
export const POSTHOG_KEY: string =
  process.env.POSTHOG_API_KEY ?? "phc_B8y7hMMmHYVEmkUfiLfuBcWoWM5GjbnaT9oBZLZnyPB3";
export const POSTHOG_HOST: string = process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com";

/**
 * The whole latency budget telemetry is allowed to cost a run: one POST,
 * aborted at this cap, no retries (§134). A metrics request must never be
 * the slowest part of somebody's render.
 */
export const FLUSH_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const freshDefaults = () => ({
  anonymousId: randomUUID(),
  enabled: true,
  noticeShown: false,
  produceCount: 0,
  ratingAsked: 0,
  ratingDone: false,
});

/**
 * Per-field `.catch` so a hand-edited or truncated telemetry.json degrades a
 * FIELD at a time (a corrupt `enabled` must not throw away the anonymousId),
 * and an outer `.catch` so a document that isn't even an object resets whole
 * — a corrupt state file must never crash the CLI it is riding in.
 */
export const TelemetryStateSchema = z
  .object({
    anonymousId: z.string().min(1).catch(() => randomUUID()),
    enabled: z.boolean().catch(true),
    noticeShown: z.boolean().catch(false),
    produceCount: z.number().int().min(0).catch(0),
    ratingAsked: z.number().int().min(0).catch(0),
    ratingDone: z.boolean().catch(false),
  })
  .catch(freshDefaults);
export type TelemetryState = z.infer<typeof TelemetryStateSchema>;

export function defaultTelemetryState(): TelemetryState {
  return freshDefaults();
}

export type TelemetryOffReason = "placeholder-key" | "env" | "do-not-track" | "config";

/**
 * Why telemetry is off, or null when it is on. Precedence, most global first:
 * a keyless build can never send (§134's hard-off invariant), an exported env
 * var is the user's word in THIS shell, DO_NOT_TRACK is the ecosystem-wide
 * spelling of the same word, and the config file is the persisted preference.
 * The reason (not just the boolean) exists for `ossclip telemetry status`,
 * which must name the switch that won.
 */
export function telemetryOffReason(
  env: NodeJS.ProcessEnv,
  state: { enabled: boolean },
  apiKey: string = POSTHOG_KEY,
): TelemetryOffReason | null {
  if (apiKey === POSTHOG_PLACEHOLDER) return "placeholder-key";
  if (["0", "false", "off"].includes(env.OSSCLIP_TELEMETRY ?? "")) return "env";
  if (["1", "true"].includes(env.DO_NOT_TRACK ?? "")) return "do-not-track";
  if (state.enabled === false) return "config";
  return null;
}

export function telemetryDisabled(
  env: NodeJS.ProcessEnv,
  state: { enabled: boolean },
  apiKey: string = POSTHOG_KEY,
): boolean {
  return telemetryOffReason(env, state, apiKey) !== null;
}

/**
 * Substrings no event prop key may contain, case-insensitively. This is the
 * privacy promise as code: a future `source_path` or `intentText` prop fails
 * loudly in the unit tests instead of quietly shipping user data. "text" and
 * "hook" cover the producer's copy fields; "key" covers credentials.
 */
export const FORBIDDEN_PROP_KEYS = [
  "path",
  "file",
  "dir",
  "transcript",
  "intent",
  "prompt",
  "key",
  "hook",
  "text",
] as const;

export function assertSafeProps(props: Record<string, unknown>): void {
  for (const key of Object.keys(props)) {
    const lower = key.toLowerCase();
    for (const forbidden of FORBIDDEN_PROP_KEYS) {
      if (lower.includes(forbidden)) {
        throw new Error(
          `telemetry prop "${key}" contains forbidden substring "${forbidden}" — ` +
            "event props must never carry paths, names, text or keys (FINDINGS §134)",
        );
      }
    }
  }
}

export interface EventContext {
  anonymousId: string;
  version: string;
  platform: string;
  arch: string;
  nodeMajor: number;
  ci: boolean;
  /** Injectable for tests; production always rides POSTHOG_KEY. */
  apiKey?: string;
}

/** The PostHog capture body — https://posthog.com/docs/api/capture */
export interface CaptureEvent {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export function buildEvent(
  name: string,
  props: Record<string, unknown>,
  ctx: EventContext,
): CaptureEvent {
  assertSafeProps(props);
  return {
    api_key: ctx.apiKey ?? POSTHOG_KEY,
    event: name,
    distinct_id: ctx.anonymousId,
    timestamp: new Date().toISOString(),
    properties: {
      ...props,
      app_version: ctx.version,
      os: ctx.platform,
      arch: ctx.arch,
      node_major: ctx.nodeMajor,
      ci: ctx.ci,
      // Anonymous events, never person profiles — the PostHog-side half of
      // the anonymity promise (and the cheaper event class, incidentally).
      $process_person_profile: false,
    },
  };
}

/**
 * The exact seconds never leave the machine — a duration is close to a
 * fingerprint of a specific take, and a bucket answers the only question we
 * have ("short-form or long-form users?") without carrying one.
 */
export function durationBucket(seconds: number): "<1m" | "1-5m" | "5-15m" | ">15m" {
  if (seconds < 60) return "<1m";
  if (seconds <= 300) return "1-5m";
  if (seconds <= 900) return "5-15m";
  return ">15m";
}

/**
 * Ask after the 3rd successful produce (someone still around at three runs
 * has an opinion worth having), never again after an answer, and never more
 * than twice — two Enter-skips is an answer too.
 */
export function shouldAskRating(state: TelemetryState): boolean {
  return !state.ratingDone && state.ratingAsked < 2 && state.produceCount >= 3;
}

/**
 * Parsed, not coerced (§93a shape): only a lone 1-5 counts. "3.5", "great"
 * and "" are all a skip, never a Number()-mangled score.
 */
const RatingSchema = z
  .string()
  .trim()
  .regex(/^[1-5]$/)
  .transform(Number);

export function parseRating(line: string): number | null {
  const parsed = RatingSchema.safeParse(line);
  return parsed.success ? parsed.data : null;
}

/**
 * The one-time first-run notice. LOUD by design — an opt-out default is only
 * honest if the opt-out is impossible to miss — and it states the privacy
 * floor in the same breath.
 */
export const NOTICE = [
  "▸ ossclip collects anonymous usage events — command counts, durations, the LLM",
  "  provider name. It NEVER sends your footage, transcripts, file names, paths,",
  "  or prompts. Turn it off any time: `ossclip telemetry off` or OSSCLIP_TELEMETRY=0.",
  '  Details and the full event list: README, "Telemetry".',
].join("\n");

export const RATING_PROMPT = "Rate ossclip so far? 1-5, Enter to skip: ";

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function telemetryStatePath(configDir: string = CONFIG_DIR): string {
  return join(configDir, "telemetry.json");
}

/**
 * Read-only: a load never writes. Persistence happens only at the explicit
 * saveState call sites (notice shown, produce counted, rating answered,
 * on/off toggled) — which is what lets the placeholder-key build guarantee
 * "no state writes" by simply never reaching those sites (§134).
 */
export function loadState(configDir: string = CONFIG_DIR): TelemetryState {
  let raw: string;
  try {
    raw = readFileSync(telemetryStatePath(configDir), "utf8");
  } catch {
    return defaultTelemetryState(); // no file yet — first run
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined; // corrupt file → the schema's outer catch resets it
  }
  return TelemetryStateSchema.parse(parsed);
}

export function saveState(state: TelemetryState, configDir: string = CONFIG_DIR): void {
  mkdirSync(configDir, { recursive: true });
  // 0600: the anonymousId is not a secret, but a state file only its owner
  // can read costs nothing and forecloses the question.
  writeFileSync(telemetryStatePath(configDir), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function cliVersion(): string {
  // Same manifest-read as program.ts's .version() (R22 §113) — a literal here
  // would report a stale number for the life of every release after it.
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return "0.0.0";
  }
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return env.CI !== undefined && !["", "0", "false"].includes(env.CI);
}

/**
 * One instance per CLI invocation. `record` buffers, `flush` sends one batch;
 * both are internally safe — telemetry must never break, slow (beyond
 * FLUSH_TIMEOUT_MS) or noisy-up a run, so errors are swallowed HERE rather
 * than try/caught at every call site.
 */
export class Telemetry {
  private readonly events: CaptureEvent[] = [];
  private readonly ctx: EventContext;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    readonly state: TelemetryState,
    private readonly fetchImpl: typeof fetch = fetch,
    ctx?: Partial<EventContext>,
  ) {
    this.ctx = {
      anonymousId: ctx?.anonymousId ?? state.anonymousId,
      version: ctx?.version ?? cliVersion(),
      platform: ctx?.platform ?? process.platform,
      arch: ctx?.arch ?? process.arch,
      nodeMajor: ctx?.nodeMajor ?? Number.parseInt(process.versions.node, 10),
      ci: ctx?.ci ?? isCi(env),
      apiKey: ctx?.apiKey,
    };
  }

  get disabled(): boolean {
    return telemetryDisabled(this.env, this.state, this.ctx.apiKey ?? POSTHOG_KEY);
  }

  record(name: string, props: Record<string, unknown> = {}): void {
    try {
      if (this.disabled) return;
      this.events.push(buildEvent(name, props, this.ctx));
    } catch {
      // Fail CLOSED: a prop key tripping assertSafeProps means the event
      // would have carried something the privacy floor forbids — dropping it
      // is the correct production outcome (no data beats wrong data), and
      // the unit tests on buildEvent are where the throw is seen and fixed.
    }
  }

  async flush(): Promise<void> {
    const batch = this.events.splice(0);
    if (batch.length === 0) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FLUSH_TIMEOUT_MS);
    try {
      // Raced against our own abort, not just handed the signal: an injected
      // fetch (tests) or a polyfill that ignores `signal` would otherwise
      // hang this await past the cap — the exact promise flush exists to keep.
      await Promise.race([
        this.fetchImpl(`${POSTHOG_HOST}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: this.ctx.apiKey ?? POSTHOG_KEY, batch }),
          signal: ac.signal,
        }),
        new Promise<void>((resolveRace) => {
          ac.signal.addEventListener("abort", () => resolveRace(), { once: true });
        }),
      ]);
    } catch {
      // Swallow everything — refused, offline, DNS, 4xx/5xx, abort. No
      // retries either: a metrics batch is not worth a second attempt's
      // latency, and the next run sends fresh events anyway.
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Prints the first-run notice once and persists the flag. */
export function maybeShowNotice(
  state: TelemetryState,
  out: (s: string) => void,
  configDir: string = CONFIG_DIR,
): void {
  if (state.noticeShown) return;
  out(NOTICE);
  state.noticeShown = true;
  saveState(state, configDir);
}

/**
 * The per-invocation entry point program.ts calls before dispatch. With the
 * placeholder key this returns an inert instance WITHOUT touching disk —
 * shipping keyless must be silent (§134), and it is also what keeps every
 * `buildProgram()` in the test suite from writing ~/.ossclip.
 */
export function bootstrapTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  out: (s: string) => void = console.log,
): Telemetry {
  if (POSTHOG_KEY === POSTHOG_PLACEHOLDER) {
    return new Telemetry(env, defaultTelemetryState());
  }
  // Env-level off (OSSCLIP_TELEMETRY / DO_NOT_TRACK) returns BEFORE any disk
  // touch: a run the user switched off must not read or create ~/.ossclip
  // state — and it is also what keeps the test suite (which exports
  // OSSCLIP_TELEMETRY=0 from vitest.config.ts) out of the real home dir.
  if (telemetryDisabled(env, { enabled: true })) {
    return new Telemetry(env, defaultTelemetryState());
  }
  let telemetry: Telemetry;
  try {
    const state = loadState();
    telemetry = new Telemetry(env, state);
    if (!telemetry.disabled && !state.noticeShown) {
      maybeShowNotice(state, out);
      // Piggybacks on noticeShown — one flag, sent exactly once. Flushed
      // fire-and-forget because the first command may be one that never
      // flushes itself (doctor, setup); the request rides while it runs.
      telemetry.record("cli_first_run", {});
      void telemetry.flush();
    }
  } catch {
    // A read-only home dir or a hostile state file must never take the CLI
    // down — telemetry degrades to inert, the run proceeds.
    telemetry = new Telemetry(env, defaultTelemetryState());
  }
  return telemetry;
}

/**
 * The one-time rating ask, AFTER the run's own output so it is the last thing
 * on screen. TTY-only and CI-excluded: a prompt into a pipe is a hang, and a
 * prompt at a CI log is noise. Internally safe like the class methods.
 */
export async function maybeAskRating(
  telemetry: Telemetry,
  opts: {
    isTTY?: boolean;
    ci?: boolean;
    ask?: () => Promise<string | null>;
    configDir?: string;
  } = {},
): Promise<void> {
  try {
    if (telemetry.disabled) return;
    if (!shouldAskRating(telemetry.state)) return;
    const tty = opts.isTTY ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
    if (!tty) return;
    if (opts.ci ?? isCi(process.env)) return;
    const line = await (opts.ask ?? askRatingOnce)();
    const score = line === null ? null : parseRating(line);
    if (score !== null) {
      telemetry.record("rating_submitted", { score });
      telemetry.state.ratingDone = true;
    } else {
      // Empty, invalid, or timed out — all a skip; two skips end the asking.
      telemetry.state.ratingAsked += 1;
    }
    saveState(telemetry.state, opts.configDir);
  } catch {
    // A rating prompt failing must never fail the produce that preceded it.
  }
}

async function askRatingOnce(): Promise<string | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 30s and gone: an unattended terminal must not hold the process open —
    // a timeout is just Enter pressed by nobody.
    return await rl.question(RATING_PROMPT, { signal: AbortSignal.timeout(30_000) });
  } catch {
    return null;
  } finally {
    rl.close();
  }
}
