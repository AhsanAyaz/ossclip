/**
 * What command.json must record: the argv of the parse that ACTUALLY ran
 * (§129).
 *
 * `produce` records its invocation into the workdir so the editor's Render
 * button can replay it byte for byte. It used to record `process.argv`,
 * which is the truth for exactly one entry point — a directly typed
 * `ossclip produce …`. The wizard has always BUILT a produce argv and
 * re-entered `program.parseAsync(["node", "ossclip", ...argv])`, and the
 * bare-path route does the same; in both, process.argv still holds the
 * ORIGINAL invocation — no `produce` literal, none of the wizard's answers —
 * so every re-entered run recorded a command that replays as
 * `ossclip <path> --llm …` and dies at commander's front door with
 * "error: unknown option '--llm'" (§129's field artifact). The re-entry
 * sites in program.ts stash the argv they are about to parse here; the
 * recording prefers the stash and falls back to process.argv, which keeps
 * the direct path byte-identical to what it always wrote.
 */

let stashed: string[] | null = null;

/**
 * Called by every parseAsync re-entry in program.ts, immediately before the
 * parse, with the argv minus its ["node", "ossclip"] prefix. Copied so a
 * caller reusing its array cannot retroactively edit the record.
 */
export function setReplayArgv(argv: string[]): void {
  stashed = [...argv];
}

/**
 * Consume-on-read (§129): commander 12 keeps option state across parseAsync
 * calls (see the bare-`produce` refusal in program.ts), and a stash kept
 * across parses would be the same trap one layer up — a menu choice that
 * never reaches `produce` must not leave its argv behind for a later
 * recording in the same process to mistake for its own.
 */
export function consumeReplayArgv(): string[] | null {
  const argv = stashed;
  stashed = null;
  return argv;
}

/**
 * The args `produce` writes into command.json: the argv of the parse that
 * ran (stash for a re-entered wizard/bare-path run, process.argv for a
 * directly typed one), plus the §75/§93g pins. The pins guard on
 * `includes` so a flag the user actually typed — or a pin recorded by the
 * run a replay is re-running — is never appended twice.
 */
export function recordedProduceArgs(pins: {
  llm?: string;
  clipWindow?: string;
  watermark?: boolean;
  captions?: boolean;
}): string[] {
  const args = consumeReplayArgv() ?? process.argv.slice(2);
  if (pins.llm !== undefined && !args.includes("--llm")) {
    args.push("--llm", pins.llm);
  }
  if (pins.clipWindow !== undefined && !args.includes("--clip-window")) {
    args.push("--clip-window", pins.clipWindow);
  }
  // The watermark, pinned like §75 pinned the provider — in BOTH directions
  // (review, Important): the effective default is config-dependent, so "no
  // flag in the argv" does not replay identically everywhere. An off-record
  // left unpinned would silently GAIN a watermark the moment the replay runs
  // under a config-on (`~/.ossclip/config.json` edited later, or the editor's
  // Render on another machine) — the exact drift §75 exists to prevent, just
  // mirrored. So every record carries the RESOLVED state: `--watermark` when
  // on, `--no-watermark` when off, and a typed flag (already in the argv,
  // caught by the includes-guard) is never doubled. One flag per command.json
  // is the price; determinism is the contract, byte-identity of off-records
  // was only ever a nicety.
  if (pins.watermark !== undefined && !args.includes("--watermark") && !args.includes("--no-watermark")) {
    args.push(pins.watermark ? "--watermark" : "--no-watermark");
  }
  // The captions flag, pinned both ways like the watermark above — but here
  // as future-proofing plus consistency rather than a live bug: captions'
  // default is ON independent of any config today, so an argv without the
  // flag would currently replay identically everywhere. Pinned anyway
  // because (a) the watermark review already made "every record carries the
  // RESOLVED state" §75's rule, and one unpinned tri-state would turn
  // command.json's contract into per-flag trivia; and (b) the moment a
  // config key or a changed default ever appears, every unpinned old record
  // would silently re-resolve under it — the watermark's exact drift, just
  // deferred. Note this pins the FLAG's state only; the editor's
  // `captionsHidden` override is not folded in (see produce.ts's call site).
  if (pins.captions !== undefined && !args.includes("--captions") && !args.includes("--no-captions")) {
    args.push(pins.captions ? "--captions" : "--no-captions");
  }
  return args;
}
