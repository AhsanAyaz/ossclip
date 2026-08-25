import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { COVER_PROVENANCE_BASENAME, CoverProvenanceSchema, defaultTheme } from "@ossclip/core";
import type { CoverProvenance } from "@ossclip/core";
import type { CoverCompProps } from "@ossclip/renderer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COVER_FRAME_BASENAME,
  buildCoverRender,
  coverBannerText,
  coverDestination,
  coverExportNote,
  coverFrameSource,
  coverTextHold,
  parseCoverFlags,
  regenerateCover,
  resolveCoverText,
  type CoverSeams,
  CoverRenderPropsSchema,
} from "../src/cover";

/**
 * `buildCoverRender` is the ONE spelling of the renderCover arguments, shared
 * by produce, `ossclip cover` and the editor's regenerate endpoint. What this
 * file guards is the property that makes that sharing worth anything: the
 * same cover, described by produce's live values or by the provenance record
 * produce persisted, renders identically.
 */

/** Produce's live values at the call site: the pick, the resolved theme, the
 * output frame, the workdir and the destination. */
const produceInputs = {
  frameFileName: "cover-frame.png",
  text: "SIX MONTHS OF MAX, FREE",
  theme: defaultTheme,
  face: { centerXFrac: 0.5, centerYFrac: 0.38, sizeFrac: 0.22 },
  frame: { width: 1080, height: 1920 },
  publicDir: "/work/Foo-7b90ab7b",
  outPath: "/out/Foo.ossclip.cover.jpg",
  browserExecutable: "/Applications/Chrome.app/chrome",
};

/** The record produce writes for exactly that render — parsed, not hand-typed
 * as a literal, so a schema change breaks this test rather than sliding past. */
const provenance = CoverProvenanceSchema.parse({
  version: 1,
  text: produceInputs.text,
  textSource: "beatsheet",
  frame: {
    source: "source",
    timeSec: 12.4,
    face: produceInputs.face,
    hasFace: true,
    sharpness: 812.3,
    fileName: produceInputs.frameFileName,
    sourceVideo: "mezzanine.mp4",
    cropVf: "crop=1080:1440:0:120",
  },
  size: produceInputs.frame,
  out: produceInputs.outPath,
});

describe("buildCoverRender (the shared cover render step)", () => {
  it("gives identical arguments for produce's inputs and for the same values reloaded from provenance", () => {
    const fromProduce = buildCoverRender(produceInputs);
    // What a regeneration has: the record, plus theme/publicDir/browser from
    // render-props.json and the config — none of which the record carries,
    // because those belong to the run, not to the cover.
    const fromProvenance = buildCoverRender({
      frameFileName: provenance.frame.fileName,
      text: provenance.text,
      theme: defaultTheme,
      face: provenance.frame.face ?? undefined,
      frame: provenance.size,
      publicDir: produceInputs.publicDir,
      outPath: provenance.out,
      browserExecutable: produceInputs.browserExecutable,
    });
    expect(fromProvenance).toEqual(fromProduce);
    // Spelled out, because "equal to each other" would also pass if both were
    // wrong: this is the pair produce passes renderCover today.
    expect(fromProduce).toEqual({
      props: {
        frameFileName: "cover-frame.png",
        text: "SIX MONTHS OF MAX, FREE",
        theme: defaultTheme,
        // centerXFrac rides along even though the composition reads only
        // centerYFrac/sizeFrac — passed through, not narrowed.
        face: { centerXFrac: 0.5, centerYFrac: 0.38, sizeFrac: 0.22 },
        frame: { width: 1080, height: 1920 },
      },
      opts: {
        publicDir: "/work/Foo-7b90ab7b",
        outPath: "/out/Foo.ossclip.cover.jpg",
        browserExecutable: "/Applications/Chrome.app/chrome",
      },
    });
  });

  it("is pure: no mutation of its argument, and a fresh frame object each call", () => {
    const args = { ...produceInputs };
    const first = buildCoverRender(args);
    const second = buildCoverRender(args);
    expect(args).toEqual(produceInputs);
    expect(second).toEqual(first);
    // A shared `frame` object would let one caller's mutation reach another's
    // render — the seam is copied, not aliased.
    expect(second.props.frame).not.toBe(first.props.frame);
    expect(first.props.frame).not.toBe(args.frame);
  });

  it("an empty headline survives as empty — the §34 bare-frame cover", () => {
    // The composition treats "" as "the frame IS the cover"; a builder that
    // helpfully substituted a default would re-add the duplicate title.
    const plan = buildCoverRender({ ...produceInputs, text: "" });
    expect(plan.props.text).toBe("");
  });

  it("a frame with no face carries no face — the textless/no-detection path", () => {
    const plan = buildCoverRender({ ...produceInputs, face: undefined });
    expect(plan.props.face).toBeUndefined();
  });
});

describe("parseCoverFlags", () => {
  it("defaults --from to final and leaves the rest unset", () => {
    expect(parseCoverFlags({})).toEqual({
      text: undefined,
      atSec: undefined,
      from: "final",
      outPath: undefined,
    });
  });

  it("takes the two --from spellings", () => {
    expect(parseCoverFlags({ from: "final" }).from).toBe("final");
    expect(parseCoverFlags({ from: "source" }).from).toBe("source");
  });

  // The --source-fit rule (program.ts): a typo that silently falls back is the
  // exact mistake the flag exists to prevent — here it would rebuild the cover
  // from the wrong video and say nothing.
  it("refuses a typo'd --from instead of falling back to final", () => {
    expect(() => parseCoverFlags({ from: "finall" })).toThrow(/--from wants "final" or "source"/);
    expect(() => parseCoverFlags({ from: "" })).toThrow(/--from/);
  });

  it("parses --at as a finite, non-negative number of seconds", () => {
    expect(parseCoverFlags({ at: "12.4" }).atSec).toBe(12.4);
    expect(parseCoverFlags({ at: "0" }).atSec).toBe(0);
  });

  it("refuses a negative, non-numeric or empty --at rather than seeking to zero", () => {
    expect(() => parseCoverFlags({ at: "-3" })).toThrow(/--at wants a timestamp/);
    expect(() => parseCoverFlags({ at: "abc" })).toThrow(/--at wants a timestamp/);
    expect(() => parseCoverFlags({ at: "" })).toThrow(/--at wants a timestamp/);
    expect(() => parseCoverFlags({ at: "Infinity" })).toThrow(/--at wants a timestamp/);
  });
});

/**
 * The wiring between the declared flags and the parser, against the REAL
 * program — the drift produce-argv-roundtrip.test.ts exists to catch, applied
 * to this command: renaming `--at` here without renaming the key
 * `parseCoverFlags` reads would leave every timestamp silently ignored.
 */
describe("the `cover` command's declared flags", () => {
  const parseArgv = async (argv: string[]): Promise<Record<string, unknown>> => {
    const { buildProgram } = await import("../src/program");
    const program = buildProgram();
    for (const cmd of [program, ...program.commands]) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr() {} });
    }
    const cover = program.commands.find((c) => c.name() === "cover");
    if (cover === undefined) throw new Error("the real program has no `cover` command");
    let captured: Record<string, unknown> = {};
    // Replaces the shipped action; every option declaration above it is real.
    cover.action((_workdir: string | undefined, opts: Record<string, unknown>) => {
      captured = opts;
    });
    await program.parseAsync(["node", "ossclip", ...argv]);
    return captured;
  };

  it("lands on the keys parseCoverFlags reads", async () => {
    const opts = await parseArgv([
      "cover", "--text", "A headline", "--at", "12.4", "--from", "source", "--out", "~/c.jpg",
    ]);
    expect(parseCoverFlags(opts)).toEqual({
      text: "A headline",
      atSec: 12.4,
      from: "source",
      outPath: "~/c.jpg",
    });
  });

  it("defaults --from to final, and a typo'd one still fails the parse", async () => {
    expect(parseCoverFlags(await parseArgv(["cover"])).from).toBe("final");
    // commander happily accepts any string for `--from <video>`; the refusal
    // is zod's, on the value the real declaration yields.
    const typo = await parseArgv(["cover", "--from", "finall"]);
    expect(() => parseCoverFlags(typo)).toThrow(/--from wants/);
  });
});

describe("resolveCoverText", () => {
  it("reports the trim instead of silently shipping a shortened headline", () => {
    const chosen = resolveCoverText({
      typed: "this headline has far too many words to survive on a cover image at all",
      persisted: null,
    });
    expect(chosen.textSource).toBe("user");
    expect(chosen.text.split(" ").length).toBeLessThanOrEqual(9);
    expect(chosen.notes.join("\n")).toContain(
      `trimmed to fit the 9-word cap: "${chosen.text}"`,
    );
  });

  // The line reported a word count it had not produced: `coverHeadline` cuts
  // to the cap and THEN pops trailing dangling words, so "trimmed to 9 words"
  // sat above an 8-word headline. The cap is named as a cap now.
  it("names the cap rather than claiming the output's length", () => {
    const chosen = resolveCoverText({
      typed: "Come and join the biggest hackathon in Karachi and build with us",
      persisted: null,
    });
    expect(chosen.text.split(" ").length).toBeLessThan(9);
    const note = chosen.notes.join("\n");
    expect(note).toContain(`trimmed to fit the 9-word cap: "${chosen.text}"`);
    // The false claim, in the exact shape it shipped in.
    expect(note).not.toContain("trimmed to 9 words");
    expect(chosen.notes).toHaveLength(1);
  });

  it("says nothing when the headline survived intact", () => {
    const chosen = resolveCoverText({ typed: "  Six  months of Max, free  ", persisted: null });
    // Whitespace collapsing is not a trim — reporting it would cry wolf on
    // every headline typed with a double space.
    expect(chosen.text).toBe("Six months of Max, free");
    expect(chosen.notes).toEqual([]);
  });

  it("reuses the persisted text VERBATIM, empty included, and keeps its source", () => {
    // The §34 case: produce persisted "" because the frame carried the
    // source's own title. Regenerating must not invent a banner.
    expect(resolveCoverText({ persisted: { text: "", textSource: "beatsheet" } })).toEqual({
      text: "",
      textSource: "beatsheet",
      notes: [],
    });
    expect(resolveCoverText({ persisted: { text: "MINE", textSource: "user" } })).toEqual({
      text: "MINE",
      textSource: "user",
      notes: [],
    });
  });

  // Decided (2026-08-19): `ossclip cover` cannot re-run the §34 suppression —
  // it needs sourceText.regions, which no workdir persists — so an explicit
  // --text is taken as explicit intent and always renders as a banner.
  it("an explicit --text overrides a §34-suppressed empty headline", () => {
    const chosen = resolveCoverText({
      typed: "A headline the user typed",
      persisted: { text: "", textSource: "beatsheet" },
    });
    expect(chosen).toEqual({
      text: "A headline the user typed",
      textSource: "user",
      notes: [],
    });
  });

  it("a workdir with no provenance and no --text says the cover ships bare", () => {
    const chosen = resolveCoverText({ persisted: null });
    expect(chosen.text).toBe("");
    expect(chosen.notes.join("\n")).toContain("no banner");
  });
});

describe("coverFrameSource", () => {
  const provenance = provenanceFixture();

  it("--from final reads the recorded out", () => {
    expect(
      coverFrameSource({
        from: "final",
        workdir: "/work",
        recordedOut: "/out/Foo.mp4",
        provenance,
        exists: (p) => p === "/out/Foo.mp4",
      }),
    ).toEqual({ path: "/out/Foo.mp4" });
  });

  it("--from final falls back to render-raw.mp4 when the out moved or never rendered", () => {
    const raw = join("/work", "render-raw.mp4");
    expect(
      coverFrameSource({
        from: "final",
        workdir: "/work",
        recordedOut: "/out/moved-away.mp4",
        provenance,
        exists: (p) => p === raw,
      }),
    ).toEqual({ path: raw });
    // …and with no recorded out at all — a --workdir run that never had one.
    expect(
      coverFrameSource({
        from: "final",
        workdir: "/work",
        recordedOut: null,
        provenance,
        exists: (p) => p === raw,
      }),
    ).toEqual({ path: raw });
  });

  it("--from final with neither video points at --from source", () => {
    expect(() =>
      coverFrameSource({
        from: "final",
        workdir: "/work",
        recordedOut: "/out/Foo.mp4",
        provenance,
        exists: () => false,
      }),
    ).toThrow(/--from source/);
  });

  // The cropVf is the reason provenance exists: re-picking from the source
  // without it frames two-thirds baked-in black bar.
  it("--from source resolves a workdir-relative video and carries the crop", () => {
    expect(
      coverFrameSource({
        from: "source",
        workdir: "/work",
        recordedOut: null,
        provenance,
        exists: () => true,
      }),
    ).toEqual({ path: join("/work", "mezzanine.mp4"), cropVf: "crop=1080:1440:0:120" });
  });

  it("--from source keeps an absolute recorded video absolute", () => {
    const abs = { ...provenance, frame: { ...provenance.frame, sourceVideo: "/takes/raw.mov" } };
    expect(
      coverFrameSource({
        from: "source",
        workdir: "/work",
        recordedOut: null,
        provenance: abs,
        exists: () => true,
      }).path,
    ).toBe("/takes/raw.mov");
  });

  it("--from source without provenance names the file it needs", () => {
    expect(() =>
      coverFrameSource({
        from: "source",
        workdir: "/work",
        recordedOut: "/out/Foo.mp4",
        provenance: null,
        exists: () => true,
      }),
    ).toThrow(new RegExp(COVER_PROVENANCE_BASENAME));
  });

  // The honest answer to "which original take was this cut from?" when
  // nothing recorded one. The alternative that shipped once was reading the
  // FINISHED render and calling it the source.
  it("--from source refuses a provenance whose source video is null, rather than reading the final", () => {
    const unknown = { ...provenance, frame: { ...provenance.frame, sourceVideo: null } };
    expect(() =>
      coverFrameSource({
        from: "source",
        workdir: "/work",
        recordedOut: "/out/Foo.mp4",
        provenance: unknown,
        exists: () => true,
      }),
    ).toThrow(/records no source video/);
  });
});

describe("coverDestination", () => {
  it("without a flag, both destinations are the same file: the last cover's, then <out>.cover.jpg", () => {
    expect(
      coverDestination({ provenanceOut: "/out/Foo.ossclip.cover.jpg", recordedOut: "/out/Foo.mp4" }),
    ).toEqual({
      render: "/out/Foo.ossclip.cover.jpg",
      canonical: "/out/Foo.ossclip.cover.jpg",
    });
    expect(coverDestination({ recordedOut: "/out/Foo.mp4" })).toEqual({
      render: "/out/Foo.cover.jpg",
      canonical: "/out/Foo.cover.jpg",
    });
  });

  // The 2026-08-19 bug in one assertion: a one-off export must not repoint
  // where this project's cover lives, or every later flagless run — and the
  // editor's panel — follows it to /tmp.
  it("a flag moves only THIS run's write; the canonical destination is untouched", () => {
    expect(
      coverDestination({
        flag: "~/previews/one-off.jpg",
        provenanceOut: "/out/Foo.ossclip.cover.jpg",
        recordedOut: "/out/Foo.mp4",
        cwd: "/here",
      }),
    ).toEqual({
      render: join(homedir(), "previews/one-off.jpg"),
      canonical: "/out/Foo.ossclip.cover.jpg",
    });
    // With no prior cover the recorded out still names the canonical one.
    expect(
      coverDestination({ flag: "covers/new.jpg", recordedOut: "/out/Foo.mp4", cwd: "/here" }),
    ).toEqual({ render: "/here/covers/new.jpg", canonical: "/out/Foo.cover.jpg" });
  });

  it("with nothing to protect, the flag IS the canonical destination", () => {
    // No prior cover and no recorded out: the flag is the only place this
    // project's cover has ever lived, so recording it redirects nothing.
    expect(coverDestination({ flag: "covers/new.jpg", recordedOut: null, cwd: "/here" })).toEqual({
      render: "/here/covers/new.jpg",
      canonical: "/here/covers/new.jpg",
    });
  });

  it("refuses to guess when there is neither, and names the flag", () => {
    expect(() => coverDestination({ recordedOut: null })).toThrow(/--out/);
  });
});

/**
 * The other half of the same 2026-08-19 decision: keeping the canonical
 * destination put means a one-off run leaves the persisted text describing a
 * cover the project's own JPEG does not display — so the run has to SAY so.
 */
describe("coverExportNote", () => {
  it("names the project's own cover and the flagless re-run that updates it", () => {
    const note = coverExportNote({
      render: "/tmp/preview.jpg",
      canonical: "/out/Foo.ossclip.cover.jpg",
    });
    expect(note).toContain("/out/Foo.ossclip.cover.jpg");
    expect(note).toContain("no --out");
    // The one-off path is already on the ✓ line above it; repeating it here
    // would make a two-path line out of a one-line note.
    expect(note).not.toContain("/tmp/preview.jpg");
  });

  it("says nothing when the run wrote the project's own cover", () => {
    expect(
      coverExportNote({
        render: "/out/Foo.ossclip.cover.jpg",
        canonical: "/out/Foo.ossclip.cover.jpg",
      }),
    ).toBeNull();
  });
});

/**
 * Produce's side of the contract: `cover.json` is a user-owned file the way
 * overrides.json and thumbnail-concept-approved.json are, and produce's cover
 * block is a thin caller of this decision.
 */
describe("coverTextHold", () => {
  const generated = "THE FRESH BEAT SHEET HEADLINE";

  it("keeps a user headline and says how to opt back out", () => {
    const held = coverTextHold({
      generated,
      persisted: { text: "MINE, TYPED", textSource: "user" },
      reset: false,
    });
    expect(held.text).toBe("MINE, TYPED");
    expect(held.textSource).toBe("user");
    expect(held.message).toContain("MINE, TYPED");
    expect(held.message).toContain("--cover-text-reset");
    expect(held.message).toContain(COVER_PROVENANCE_BASENAME);
  });

  it("--cover-text-reset opts back into the generated one, and says so", () => {
    const held = coverTextHold({
      generated,
      persisted: { text: "MINE, TYPED", textSource: "user" },
      reset: true,
    });
    expect(held.text).toBe(generated);
    expect(held.textSource).toBe("beatsheet");
    expect(held.message).toContain("--cover-text-reset");
  });

  it("a beat-sheet headline is not user-owned — no hold, and no line printed", () => {
    for (const persisted of [
      null,
      { text: "LAST RUN'S", textSource: "beatsheet" as const },
    ]) {
      expect(coverTextHold({ generated, persisted, reset: false })).toEqual({
        text: generated,
        textSource: "beatsheet",
      });
    }
  });

  // produce persists the text it RENDERED, so a §34 run (the frame carried
  // the source's own title) writes text: "". Holding that would silently ban
  // the banner from every future run of this project.
  it("does not hold an empty user text", () => {
    expect(
      coverTextHold({ generated, persisted: { text: "  ", textSource: "user" }, reset: false }),
    ).toEqual({ text: generated, textSource: "beatsheet" });
  });
});

/**
 * §34's dedupe, and the one headline it must not eat. Produce's cover block
 * is a thin caller of this — it prints `note` verbatim and renders `text`.
 */
describe("coverBannerText", () => {
  const headline = "SIX MONTHS OF MAX, FREE";

  it("renders the headline when the source frame carries no title of its own", () => {
    for (const textSource of ["beatsheet", "user"] as const) {
      expect(coverBannerText({ text: headline, textSource, sourceTitled: false })).toEqual({
        text: headline,
      });
    }
  });

  // §34 unchanged for a GENERATED headline: two titles in one image is what
  // the rule is about, and this is the line produce has always printed.
  it("suppresses a generated headline against a titled frame, and says so", () => {
    const banner = coverBannerText({
      text: headline,
      textSource: "beatsheet",
      sourceTitled: true,
    });
    expect(banner.text).toBe("");
    expect(banner.note).toBe(
      "  ▸ source already has a title in this frame — shipping it without a banner",
    );
  });

  // The failure textSource: "user" exists to prevent: a headline typed via
  // `ossclip cover --text` silently erased by the next produce.
  it("keeps a user headline against a titled frame, and does not claim it shipped bare", () => {
    const banner = coverBannerText({ text: headline, textSource: "user", sourceTitled: true });
    expect(banner.text).toBe(headline);
    expect(banner.note).toContain("keeping your headline");
    expect(banner.note).toContain("--cover-text-reset");
    expect(banner.note).not.toContain("without a banner");
  });

  // Nothing to keep, so nothing to say about keeping it — the same reasoning
  // that stops coverTextHold holding an empty user text.
  it("treats a blank user headline as the suppression it already is", () => {
    expect(coverBannerText({ text: "  ", textSource: "user", sourceTitled: true })).toEqual({
      text: "",
      note: "  ▸ source already has a title in this frame — shipping it without a banner",
    });
  });
});

/** The provenance produce writes, as a plain object the tests reshape. */
function provenanceFixture(): CoverProvenance {
  return CoverProvenanceSchema.parse({
    version: 1,
    text: "SIX MONTHS OF MAX, FREE",
    textSource: "beatsheet",
    frame: {
      source: "source",
      timeSec: 12.4,
      face: { centerXFrac: 0.5, centerYFrac: 0.38, sizeFrac: 0.22 },
      hasFace: true,
      sharpness: 812.3,
      fileName: COVER_FRAME_BASENAME,
      sourceVideo: "mezzanine.mp4",
      cropVf: "crop=1080:1440:0:120",
    },
    size: { width: 1080, height: 1920 },
    out: "/out/Foo.ossclip.cover.jpg",
  });
}

/**
 * `regenerateCover` end to end on a real workdir, with every I/O seam
 * injected: no Remotion, no ffmpeg, no config read. The frame seams THROW by
 * default — that is how the text-only path proves it shells out to nothing,
 * which is the whole reason a headline change costs seconds.
 */
describe("regenerateCover", () => {
  let dir: string;
  let rendered: Array<{ props: CoverCompProps; opts: Record<string, unknown> }>;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-cover-"));
    rendered = [];
    lines = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seams = (over: Partial<CoverSeams> = {}): CoverSeams => ({
    renderCover: async (props, opts) => {
      rendered.push({ props, opts: opts as unknown as Record<string, unknown> });
    },
    grabFrame: async () => {
      throw new Error("ffmpeg must not run on this path");
    },
    pickFrame: async () => {
      throw new Error("a re-pick must not run on this path");
    },
    log: (l) => lines.push(l),
    ...over,
  });

  const writeWorkdir = (over: Record<string, unknown> = {}): void => {
    writeFileSync(
      join(dir, "render-props.json"),
      JSON.stringify({
        videoFileName: "clip.mp4",
        theme: { ...defaultTheme, accent: "#00FF00" },
        settings: { width: 1080, height: 1920, fps: 30 },
        ...over,
      }),
    );
  };

  const writeProvenance = (over: Partial<CoverProvenance> = {}): CoverProvenance => {
    const p = { ...provenanceFixture(), out: join(dir, "Foo.cover.jpg"), ...over };
    writeFileSync(join(dir, COVER_PROVENANCE_BASENAME), JSON.stringify(p));
    writeFileSync(join(dir, p.frame.fileName), "png-bytes");
    return p;
  };

  const readProvenance = (): CoverProvenance =>
    CoverProvenanceSchema.parse(
      JSON.parse(readFileSync(join(dir, COVER_PROVENANCE_BASENAME), "utf8")),
    );

  it("a text-only change re-uses the still on disk and runs no ffmpeg at all", async () => {
    writeWorkdir();
    const before = writeProvenance();
    const written = await regenerateCover(dir, { text: "A brand new headline" }, seams());

    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.props).toEqual({
      frameFileName: COVER_FRAME_BASENAME,
      text: "A brand new headline",
      // The RESOLVED theme from render-props.json, not defaultTheme — an
      // editor theme change flows into a regenerated cover for free.
      theme: { ...defaultTheme, accent: "#00FF00" },
      face: before.frame.face,
      frame: { width: 1080, height: 1920 },
    });
    expect(rendered[0]!.opts).toEqual({
      publicDir: dir,
      outPath: before.out,
      browserExecutable: undefined,
    });
    // The frame record survives untouched, so the NEXT regeneration is cheap
    // too — and the text is now user-owned.
    expect(written.frame).toEqual(before.frame);
    expect(readProvenance()).toEqual({ ...before, text: "A brand new headline", textSource: "user" });
    expect(lines.join("\n")).toContain("no frame extraction");
  });

  it("reports the trimmed headline rather than silently shipping it", async () => {
    writeWorkdir();
    writeProvenance();
    const written = await regenerateCover(
      dir,
      { text: "this headline has far too many words to survive on a cover image at all" },
      seams(),
    );
    expect(lines.join("\n")).toContain(`trimmed to fit the 9-word cap: "${written.text}"`);
    expect(rendered[0]!.props.text).toBe(written.text);
  });

  // 2026-08-19: `--out /tmp/preview.jpg` wrote the JPEG there AND persisted
  // /tmp/preview.jpg as the project's `out`, so every later flagless run — and
  // the editor's panel — followed the cover to /tmp. An export is not a move.
  it("--out is a one-off: the JPEG lands there, the persisted destination does not move", async () => {
    writeWorkdir();
    const before = writeProvenance();
    const target = join(dir, "elsewhere", "Custom.jpg");
    const written = await regenerateCover(dir, { outPath: target }, seams());
    expect(rendered[0]!.opts.outPath).toBe(target);
    expect(written.out).toBe(before.out);
    expect(readProvenance().out).toBe(before.out);
    // And it SAYS the project's own cover stayed as it was: the text this run
    // persisted now describes a headline that JPEG does not display.
    expect(lines.at(-1)).toBe(
      `▸ one-off --out: this project's own cover ${before.out} was NOT updated — ` +
        "re-run `ossclip cover` with no --out to write it there",
    );

    // And the run after it still writes the project's own cover — with no
    // divergence to report.
    lines.length = 0;
    await regenerateCover(dir, { text: "Back home" }, seams());
    expect(rendered[1]!.opts.outPath).toBe(before.out);
    expect(lines.join("\n")).not.toContain("one-off --out");
  });

  // §corr.3 — the path that fixes a cover produced before any of this
  // existed: the recorded out plus render-props.json are enough.
  it("with no cover.json, --from final resolves the recorded out and re-picks", async () => {
    writeWorkdir();
    const finalVideo = join(dir, "Foo.mp4");
    writeFileSync(finalVideo, "mp4-bytes");
    writeFileSync(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        script: "ossclip",
        args: ["produce", "take.mp4"],
        cwd: dir,
        out: "Foo.mp4",
      }),
    );
    const picked: string[] = [];
    const grabbed: Array<{ videoPath: string; timeSec: number; framePath: string }> = [];
    const written = await regenerateCover(
      dir,
      { text: "Rescued headline" },
      seams({
        pickFrame: async (req) => {
          picked.push(req.videoPath);
          return { timeSec: 7.25 };
        },
        grabFrame: async (req) => {
          grabbed.push({ videoPath: req.videoPath, timeSec: req.timeSec, framePath: req.framePath });
          return { sharpness: 640, hasFace: true, face: { centerXFrac: 0.5, centerYFrac: 0.4, sizeFrac: 0.2 } };
        },
      }),
    );

    expect(picked).toEqual([finalVideo]);
    expect(grabbed).toEqual([
      { videoPath: finalVideo, timeSec: 7.25, framePath: join(dir, COVER_FRAME_BASENAME) },
    ]);
    // Said out loud: the re-picked frame is not necessarily the one the
    // current cover shows.
    expect(lines.join("\n")).toContain("re-picking a frame");
    expect(written.frame).toEqual({
      source: "final",
      timeSec: 7.25,
      face: { centerXFrac: 0.5, centerYFrac: 0.4, sizeFrac: 0.2 },
      hasFace: true,
      sharpness: 640,
      fileName: COVER_FRAME_BASENAME,
      // NULL, not "Foo.mp4": the frame came from the finished render, and
      // nothing on this workdir records which original take it was cut from.
      // Writing the final video's path here is what made `--from source`
      // return the finished render, captions burned in.
      sourceVideo: null,
      cropVf: null,
    });
    // <recorded out>.cover.jpg, since no previous cover named a destination.
    expect(written.out).toBe(join(dir, "Foo.cover.jpg"));
    expect(readProvenance()).toEqual(written);
  });

  it("--at extracts from the recorded source with the crop provenance kept", async () => {
    writeWorkdir();
    const before = writeProvenance();
    writeFileSync(join(dir, "mezzanine.mp4"), "mp4-bytes");
    const grabbed: Array<{ videoPath: string; cropVf?: string; timeSec: number }> = [];
    const written = await regenerateCover(
      dir,
      { atSec: 3.5, from: "source" },
      seams({
        grabFrame: async (req) => {
          grabbed.push({ videoPath: req.videoPath, cropVf: req.cropVf, timeSec: req.timeSec });
          return { sharpness: 12, hasFace: false };
        },
      }),
    );
    expect(grabbed).toEqual([
      { videoPath: join(dir, "mezzanine.mp4"), cropVf: before.frame.cropVf!, timeSec: 3.5 },
    ]);
    expect(written.frame.source).toBe("source");
    expect(written.frame.face).toBeNull();
    expect(written.frame.cropVf).toBe(before.frame.cropVf);
    expect(written.frame.sourceVideo).toBe(before.frame.sourceVideo);
    // No --text: the persisted headline rides along verbatim.
    expect(written.text).toBe(before.text);
    expect(written.textSource).toBe("beatsheet");
  });

  /**
   * THE regression test (2026-08-19). `sourceVideo` used to be written from
   * whichever video the frame had just been read from, so one `ossclip cover`
   * on its DEFAULT `--from final` overwrote produce's `mezzanine.mp4` with the
   * finished render's path. After that `--from source` re-cut the cover from
   * the finished video — burned-in captions, graphics and watermark — while
   * saying it was reading the clean source, and the only on-disk record of
   * where the take lives was gone for good. `frame.source` already says which
   * video the current still came from; these two mean the ORIGINAL TAKE.
   */
  it("--at --from final preserves the original take's sourceVideo and cropVf", async () => {
    writeWorkdir();
    const before = writeProvenance();
    const finalVideo = join(dir, "Foo.mp4");
    writeFileSync(finalVideo, "mp4-bytes");
    writeFileSync(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        script: "ossclip",
        args: ["produce", "take.mp4"],
        cwd: dir,
        out: "Foo.mp4",
      }),
    );
    const grabbed: Array<{ videoPath: string; cropVf?: string }> = [];
    const written = await regenerateCover(
      dir,
      { atSec: 9 },
      seams({
        grabFrame: async (req) => {
          grabbed.push({ videoPath: req.videoPath, cropVf: req.cropVf });
          return { sharpness: 300, hasFace: false };
        },
      }),
    );
    // It really did read the FINAL video — and without the source's crop,
    // which is meaningless against an already-framed render.
    expect(grabbed).toEqual([{ videoPath: finalVideo, cropVf: undefined }]);
    expect(written.frame.source).toBe("final");
    expect(written.frame.sourceVideo).toBe("mezzanine.mp4");
    expect(written.frame.cropVf).toBe(before.frame.cropVf);
    expect(readProvenance().frame.sourceVideo).toBe("mezzanine.mp4");
  });

  it("a --from final rebuild with no provenance leaves --from source honest, not lying", async () => {
    writeWorkdir();
    const finalVideo = join(dir, "Foo.mp4");
    writeFileSync(finalVideo, "mp4-bytes");
    writeFileSync(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        script: "ossclip",
        args: ["produce", "take.mp4"],
        cwd: dir,
        out: "Foo.mp4",
      }),
    );
    const written = await regenerateCover(
      dir,
      { atSec: 4, text: "Rescued headline" },
      seams({ grabFrame: async () => ({ sharpness: 120, hasFace: false }) }),
    );
    expect(written.frame.sourceVideo).toBeNull();

    // The next run asking for the source gets an error, NOT the final render
    // dressed up as the original take.
    await expect(
      regenerateCover(dir, { atSec: 4, from: "source" }, seams()),
    ).rejects.toThrow(/records no source video/);
    expect(rendered).toHaveLength(1);
  });

  it("refuses when the recorded still is gone, naming the flag that fixes it", async () => {
    writeWorkdir();
    const p = writeProvenance();
    rmSync(join(dir, p.frame.fileName));
    await expect(regenerateCover(dir, {}, seams())).rejects.toThrow(/--at <seconds>/);
    expect(rendered).toHaveLength(0);
  });

  it("provenance is written only after the render succeeded", async () => {
    writeWorkdir();
    const before = writeProvenance();
    await expect(
      regenerateCover(
        dir,
        { text: "Never shipped" },
        seams({
          renderCover: async () => {
            throw new Error("chrome fell over");
          },
        }),
      ),
    ).rejects.toThrow(/chrome fell over/);
    // Still describing the cover that IS on disk.
    expect(readProvenance()).toEqual(before);
  });
});

/**
 * A take with no face must still be able to regenerate its cover (§154).
 *
 * `produce` writes `face: null` when the detector found nobody — that is a
 * measurement, not an absence, and core's own schema says so
 * (`schema.ts`: "null = no face found", `.nullable().optional()`). The cover's
 * copy of the shape only had `.optional()`, which accepts a MISSING key and
 * rejects an explicit null, so every screen recording and voiceover-over-slides
 * project hit:
 *
 *   render-props.json in … is not valid:
 *   { "path": ["face"], "message": "Invalid input: expected object, received null" }
 *
 * Reported from the published 0.1.29 on a terminal-recording project, where
 * "no face" is the normal case rather than an edge one. The cover panel could
 * not regenerate at all.
 */
describe("CoverRenderPropsSchema tolerates a faceless take", () => {
  const base = {
    videoFileName: "in.mp4",
    spans: [],
    captionLines: [],
    sceneCues: [],
    settings: { width: 1080, height: 1920 },
    outputDurationSec: 10,
  };

  it("accepts face: null — the shape produce actually writes when nobody is on camera", () => {
    expect(CoverRenderPropsSchema.safeParse({ ...base, face: null }).success).toBe(true);
  });

  it("still accepts a measured face, and an absent key", () => {
    expect(
      CoverRenderPropsSchema.safeParse({ ...base, face: { subject: "face" } }).success,
    ).toBe(true);
    expect(CoverRenderPropsSchema.safeParse(base).success).toBe(true);
  });

  it("null survives parsing as null, so `face?.subject` stays undefined downstream", () => {
    const parsed = CoverRenderPropsSchema.parse({ ...base, face: null });
    expect(parsed.face ?? undefined).toBeUndefined();
  });
});
