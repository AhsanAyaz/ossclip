import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OverrideDocSchema } from "@ossclip/core";
import { overridesWriteLine, writeOverrideDoc } from "../src/overrides-write";

/**
 * The `.bak` rule, on a real filesystem (§137 final review round 2, Critical 2
 * residual).
 *
 * A filesystem test on purpose: what is being pinned is that a specific FILE
 * is still there, byte for byte, after a write that had every reason to
 * replace it. There is no pure form of that claim, and the alternative —
 * `produce()` over ffmpeg, a transcript and a render — is the harness this
 * whole section keeps deferring.
 *
 * The scenario is the field workdir's, made small: `overrides.json.bak` holds
 * the user's PRE-CUT save (`splits: [0.6]`, the deleted half `scene-0@600`
 * hidden) and `overrides.json` holds the already-damaged re-anchored copy
 * (`splits: [0]`). A caption-key migration then repairs three retypes. That
 * run must write the repair and MUST NOT touch the backup — the damaged doc is
 * worth nothing as a backup, and the thing it would overwrite is the only
 * artefact `scene-0@600` can ever be matched from again.
 */
describe("writeOverrideDoc — which write may spend the `.bak` (§137)", () => {
  /** The user's pre-cut save. The only copy of `splits: [0.6]` in existence. */
  const PRE_CUT = JSON.stringify(
    { splits: [0.6], scenes: { "scene-0@600": { hidden: true } } },
    null,
    2,
  );
  /** What the re-anchoring produce run left behind: the same doc, cut-damaged. */
  const DAMAGED = JSON.stringify({ splits: [0], scenes: { "scene-0@600": { hidden: true } } }, null, 2);

  const workdir = (): { path: string; bak: string } => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-overrides-"));
    const path = join(dir, "overrides.json");
    writeFileSync(path, DAMAGED);
    writeFileSync(`${path}.bak`, PRE_CUT);
    return { path, bak: `${path}.bak` };
  };

  const doc = (captions: Record<string, { text: string; was: string }>) =>
    OverrideDocSchema.parse({ splits: [0], captions });

  it("a caption-only re-anchor writes the doc and leaves the `.bak` byte-identical", async () => {
    // The branch's own marquee scenario: three of the four retypes recovered.
    // Gating the WRITE on work done is not enough — this run legitimately has
    // work to write, and refreshing the backup here is what destroys the split.
    const { path, bak } = workdir();
    await writeOverrideDoc(path, doc({ w2368: { text: "zsh", was: "status" } }), {
      refreshBackup: false,
    });
    expect(JSON.parse(readFileSync(path, "utf8")).captions).toEqual({
      w2368: { text: "zsh", was: "status" },
    });
    expect(readFileSync(bak, "utf8")).toBe(PRE_CUT);
    // Stated as the property that actually matters, not just as bytes: the
    // split the user deleted is still derivable from the backup.
    expect(JSON.parse(readFileSync(bak, "utf8")).splits).toEqual([0.6]);
  });

  it("a cut re-anchoring DOES refresh it — that is the write the `.bak` exists for", async () => {
    // Absolute output-second values all over the doc, recomputed from a frame
    // the pipeline just built. Irreversible by hand, so the copy it replaces
    // is the one worth keeping.
    const { path, bak } = workdir();
    await writeOverrideDoc(path, doc({}), { refreshBackup: true });
    expect(readFileSync(bak, "utf8")).toBe(DAMAGED);
    expect(readFileSync(bak, "utf8")).not.toBe(PRE_CUT);
  });

  it("writes through a tmp file and leaves none behind", async () => {
    // Atomic: a live editor session may read this file at any moment.
    const { path } = workdir();
    await writeOverrideDoc(path, doc({}), { refreshBackup: false });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("does not invent a `.bak` for a workdir that never had one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-overrides-"));
    const path = join(dir, "overrides.json");
    // First cut ever applied here: nothing on disk to copy. The write must
    // still land rather than throwing on the missing read.
    await writeOverrideDoc(path, doc({}), { refreshBackup: true });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("writes a file produce can read back, with the user's own keys verbatim", async () => {
    // NOT a whole-document equality: `OverrideDocSchema` is not idempotent
    // under parse → stringify → parse. `theme` is `ThemeSchema.partial()
    // .default({})`, so an ABSENT theme comes back `{}` while a PRESENT `{}`
    // fills every default — meaning any sanctioned write bakes the current
    // palette into the user's file. Pre-existing (the cut path has always done
    // it) and out of scope here, but noted so the next person meets it in a
    // comment rather than in a diff of someone's overrides.json.
    const { path } = workdir();
    const written = doc({ w2368: { text: "zsh", was: "status" } });
    await writeOverrideDoc(path, written, { refreshBackup: false });
    const back = OverrideDocSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(back.captions).toEqual(written.captions);
    expect(back.splits).toEqual(written.splits);
  });
});

describe("overridesWriteLine", () => {
  it("claims a kept copy only on the run that actually kept one", () => {
    // A line saying "previous copy kept as .bak" over a run that took no
    // backup is how a user finds out too late.
    expect(overridesWriteLine(true)).toContain("previous copy kept as .bak");
    expect(overridesWriteLine(false)).not.toContain("kept as .bak");
    expect(overridesWriteLine(false)).toContain("left alone");
  });

  it("names which re-anchoring happened, either way", () => {
    expect(overridesWriteLine(true)).toContain("the new cut");
    expect(overridesWriteLine(false)).toContain("source-time caption keys");
  });
});
