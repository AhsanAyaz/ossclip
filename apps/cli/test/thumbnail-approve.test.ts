import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateThumbnailImageOptions, ThumbnailConcept } from "@ossclip/core";
import { ThumbnailConceptApprovedSchema } from "@ossclip/core";
import {
  approveThumbnailConcept,
  editedConcept,
  formatConceptLines,
  thumbnailRetryLoop,
  type ApprovePrompts,
} from "../src/interactive/thumbnail-approve";

/**
 * The approval and retry loops, driven through the injectable ApprovePrompts
 * seam — scripted answers in, decisions out, no TTY and no clack in the
 * loop. The generate seam keeps @google/genai out exactly as
 * thumbnail-step.test.ts does.
 */

const concept: ThumbnailConcept = {
  scene: "A developer at a glowing terminal",
  overlayText: "AGENTS EXPLAINED",
  styleNotes: "Deep blue palette, rim lighting",
};

/** Scripted prompts: selects and texts are consumed in order. */
function scripted(selects: string[], texts: string[] = []): ApprovePrompts {
  return {
    select: async () => {
      const next = selects.shift();
      if (next === undefined) throw new Error("scripted prompts ran out of select answers");
      return next;
    },
    text: async () => {
      const next = texts.shift();
      if (next === undefined) throw new Error("scripted prompts ran out of text answers");
      return next;
    },
  };
}

describe("formatConceptLines", () => {
  it("puts the overlay first — it is the one thing the viewer reads", () => {
    const lines = formatConceptLines(concept);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("overlay: AGENTS EXPLAINED");
    expect(lines[1]).toContain("scene:");
    expect(lines[2]).toContain("style:");
  });
});

describe("editedConcept", () => {
  it("passes a valid edit through the schema unchanged", () => {
    expect(editedConcept(concept)).toEqual(concept);
  });

  // §35: the schema caps characters, coverHeadline caps WORDS — a
  // hand-edited overlay must not smuggle a paragraph past the cap the
  // generated path enforces.
  it("re-applies the overlay word cap to an edited overlay", () => {
    const edited = editedConcept({
      ...concept,
      overlayText: "this overlay has far too many words to survive on a thumbnail",
    });
    expect(edited.overlayText.split(" ").length).toBeLessThanOrEqual(9);
  });

  it("caps over-length free text instead of refusing (§112, the schema's own rule)", () => {
    const edited = editedConcept({ ...concept, scene: "word ".repeat(100) });
    expect(edited.scene.length).toBeLessThanOrEqual(300);
  });
});

describe("approveThumbnailConcept", () => {
  it('"use it" returns the concept verbatim, one generate call', async () => {
    let calls = 0;
    const got = await approveThumbnailConcept({
      generateConcept: async () => {
        calls += 1;
        return concept;
      },
      prompts: scripted(["use"]),
      log: () => {},
    });
    expect(got).toEqual(concept);
    expect(calls).toBe(1);
    // The result is exactly what produce writes to disk — it must satisfy
    // the schema thumbnailStep re-reads it with.
    expect(ThumbnailConceptApprovedSchema.parse(got)).toEqual(concept);
  });

  it("an initial (cached) concept skips the generate call entirely", async () => {
    let calls = 0;
    const got = await approveThumbnailConcept({
      initial: concept,
      generateConcept: async () => {
        calls += 1;
        return concept;
      },
      prompts: scripted(["use"]),
      log: () => {},
    });
    expect(got).toEqual(concept);
    expect(calls).toBe(0);
  });

  it('"skip thumbnail" returns the schema\'s skip variant', async () => {
    const got = await approveThumbnailConcept({
      initial: concept,
      generateConcept: async () => concept,
      prompts: scripted(["skip"]),
      log: () => {},
    });
    expect(got).toEqual({ skip: true });
    expect(ThumbnailConceptApprovedSchema.parse(got)).toEqual({ skip: true });
  });

  it("edit prefills each field, re-validates, and loops back to the display", async () => {
    const displayed: string[] = [];
    const initials: (string | undefined)[] = [];
    const answers = ["EDITED OVERLAY", "an edited scene", "edited style"];
    const prompts: ApprovePrompts = {
      select: (() => {
        const script = ["edit", "use"];
        return async () => script.shift()!;
      })(),
      text: async (opts) => {
        initials.push(opts.initialValue);
        return answers.shift()!;
      },
    };
    const got = await approveThumbnailConcept({
      initial: concept,
      generateConcept: async () => concept,
      prompts,
      log: (l) => displayed.push(l),
    });
    // Prefills came from the concept on screen (overlay, scene, style order).
    expect(initials).toEqual([concept.overlayText, concept.scene, concept.styleNotes]);
    expect(got).toEqual({
      overlayText: "EDITED OVERLAY",
      scene: "an edited scene",
      styleNotes: "edited style",
    });
    // The edited concept was displayed again before "use" — the user
    // confirms what they typed, never approves blind.
    expect(displayed.join("\n")).toContain("EDITED OVERLAY");
  });

  it("regenerate passes the note to a fresh call and loops to the display", async () => {
    const notes: (string | undefined)[] = [];
    const second: ThumbnailConcept = { ...concept, overlayText: "SECOND TRY" };
    const got = await approveThumbnailConcept({
      generateConcept: async (note) => {
        notes.push(note);
        return notes.length > 1 ? second : concept;
      },
      prompts: scripted(["regenerate", "use"], ["less abstract"]),
      log: () => {},
    });
    expect(notes).toEqual([undefined, "less abstract"]);
    expect(got).toEqual(second);
  });
});

describe("thumbnailRetryLoop", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-retry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const portrait = { data: Buffer.from("face").toString("base64"), mimeType: "image/png" };

  // Every retry-loop call injects `open` — the default is the real
  // openInViewer, which would pop actual viewer windows during a test run.
  const noOpen = { open: () => {} };

  function paths(): { imagePath: string; imageCachePath: string } {
    const imagePath = join(dir, "final.thumbnail.png");
    const imageCachePath = join(dir, "thumbnail-cache.png");
    writeFileSync(imagePath, "original-image");
    writeFileSync(imageCachePath, "original-image");
    return { imagePath, imageCachePath };
  }

  it("keep exits with zero generate calls", async () => {
    let calls = 0;
    await thumbnailRetryLoop({
      ...paths(),
      ...noOpen,
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async () => {
        calls += 1;
        return new Uint8Array([1]);
      },
      prompts: scripted(["keep"]),
      log: () => {},
    });
    expect(calls).toBe(0);
  });

  it("one generate call per note, note in the prompt, cache AND destination overwritten", async () => {
    const { imagePath, imageCachePath } = paths();
    const seen: GenerateThumbnailImageOptions[] = [];
    const results = [new Uint8Array([1, 1]), new Uint8Array([2, 2])];
    await thumbnailRetryLoop({
      imagePath,
      imageCachePath,
      ...noOpen,
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async (opts) => {
        seen.push(opts);
        return results[seen.length - 1]!;
      },
      // Two retries, then keep — each iteration asks again by design.
      prompts: scripted(["regenerate", "regenerate", "keep"], ["warmer lighting", "less clutter"]),
      log: () => {},
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.prompt).toContain(
      "Revision note from the creator (must be honored): warmer lighting",
    );
    expect(seen[1]!.prompt).toContain(
      "Revision note from the creator (must be honored): less clutter",
    );
    // The concept stays FIXED across retries — same scene, same overlay.
    for (const s of seen) {
      expect(s.prompt).toContain(`Scene: ${concept.scene}`);
      expect(s.prompt).toContain("\n  AGENTS EXPLAINED");
      expect(s.portrait).toEqual(portrait);
      expect(s.apiKey).toBe("k");
      expect(s.model).toBe("m");
    }
    // Both files hold the LAST retry's bytes.
    expect(Array.from(readFileSync(imageCachePath))).toEqual([2, 2]);
    expect(Array.from(readFileSync(imagePath))).toEqual([2, 2]);
  });

  it("an empty note re-asks instead of re-rolling the same dice at API cost", async () => {
    let calls = 0;
    await thumbnailRetryLoop({
      ...paths(),
      ...noOpen,
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async () => {
        calls += 1;
        return new Uint8Array([1]);
      },
      prompts: scripted(["regenerate", "keep"], ["   "]),
      log: () => {},
    });
    expect(calls).toBe(0);
  });

  it("a failed retry keeps the previous image and says so (§132 verbatim message)", async () => {
    const { imagePath, imageCachePath } = paths();
    const lines: string[] = [];
    await thumbnailRetryLoop({
      imagePath,
      imageCachePath,
      ...noOpen,
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async () => {
        throw new Error("quota exceeded");
      },
      prompts: scripted(["regenerate", "keep"], ["warmer"]),
      log: (l) => lines.push(l),
    });
    expect(lines.join("\n")).toContain("regeneration failed (quota exceeded)");
    expect(lines.join("\n")).toContain("keeping the previous image");
    expect(readFileSync(imagePath, "utf8")).toBe("original-image");
    expect(readFileSync(imageCachePath, "utf8")).toBe("original-image");
  });

  // The viewer opens before EVERY prompt — the initial image and each
  // regeneration's — so the user always confirms the file currently on
  // disk, never a stale window (thumbnail UX, 2026-08-17).
  it("opens the image before each prompt: initial + after each regenerate", async () => {
    const { imagePath, imageCachePath } = paths();
    const opened: string[] = [];
    await thumbnailRetryLoop({
      imagePath,
      imageCachePath,
      open: (p) => opened.push(p),
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async () => new Uint8Array([1]),
      prompts: scripted(["regenerate", "regenerate", "keep"], ["warmer", "less clutter"]),
      log: () => {},
    });
    expect(opened).toEqual([imagePath, imagePath, imagePath]);
  });

  it("an open failure logs one line and still reaches the prompt", async () => {
    const { imagePath, imageCachePath } = paths();
    const lines: string[] = [];
    let prompted = 0;
    await thumbnailRetryLoop({
      imagePath,
      imageCachePath,
      open: () => {
        throw new Error("no viewer here");
      },
      concept,
      apiKey: "k",
      model: "m",
      portrait,
      generate: async () => new Uint8Array([1]),
      prompts: {
        select: async () => {
          prompted += 1;
          return "keep";
        },
        text: async () => "",
      },
      log: (l) => lines.push(l),
    });
    // The confirm proceeded on the printed path — a headless-ish env must
    // not kill the loop.
    expect(prompted).toBe(1);
    expect(lines.join("\n")).toContain(`could not open viewer — ${imagePath}`);
  });
});
