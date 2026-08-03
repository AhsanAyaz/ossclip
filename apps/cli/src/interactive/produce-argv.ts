/**
 * Wizard answers → the argv a user could have typed.
 *
 * This is the load-bearing shape of the whole interactive layer: the wizard
 * produces ARGUMENTS, not a ProduceOptions, so the zod parses in index.ts
 * stay the only validation path and the printed command is the executed one.
 */

export interface ProduceExtras {
  clip?: number;
  sourceFit?: "cover" | "contain";
  speaker?: string;
  whisperModel?: string;
  blooperMarker?: string;
  sourceIsEdited?: boolean;
  llm?: "claude" | "claude-cli" | "gemini" | "mock";
}

export interface ProduceAnswers {
  input: string;
  aspect: "9:16" | "16:9";
  cleanup: "exact" | "light" | "standard" | "aggressive";
  graphics: boolean;
  intent?: string;
  out?: string;
  extras: ProduceExtras;
}

export function produceArgv(a: ProduceAnswers): string[] {
  const argv = ["produce", a.input];

  // A flag whose value equals the default is NEVER emitted. A wizard run
  // where every answer was the default must teach `ossclip produce <file>`
  // and nothing more — anything longer becomes a command line the user
  // copies forever without knowing which parts mattered.
  if (a.aspect !== "9:16") argv.push("--aspect", a.aspect);
  if (a.cleanup !== "standard") argv.push("--cleanup", a.cleanup);
  if (a.out) argv.push("--out", a.out);

  if (a.graphics) {
    argv.push("--produce");
    // Intent feeds the producer brain, which only runs under --produce —
    // emitting it alone would be a flag with nothing to act on.
    if (a.intent) argv.push("--intent", a.intent);
  }

  const e = a.extras;
  if (e.clip !== undefined) argv.push("--clip", String(e.clip));
  if (e.sourceFit === "contain") argv.push("--source-fit", "contain");
  if (e.speaker) argv.push("--speaker", e.speaker);
  if (e.whisperModel) argv.push("--whisper-model", e.whisperModel);
  if (e.blooperMarker) argv.push("--blooper-marker", e.blooperMarker);
  if (e.sourceIsEdited === true) argv.push("--source-is-edited");
  if (e.llm) argv.push("--llm", e.llm);

  return argv;
}
