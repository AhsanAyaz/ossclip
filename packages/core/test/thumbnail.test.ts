import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import {
  PORTRAIT_MIME_TYPES,
  THUMBNAIL_MODEL_DEFAULT,
  THUMBNAIL_TRANSCRIPT_CHAR_CAP,
  ThumbnailConceptApprovedSchema,
  ThumbnailConceptSchema,
  approvedOverlayText,
  buildThumbnailConceptPrompt,
  buildThumbnailPrompt,
  extractImageBytes,
  generateThumbnailConcept,
  portraitMimeType,
  thumbnailDecision,
  thumbnailImageCacheName,
  type ThumbnailConcept,
} from "../src/thumbnail";

// NOTE: nothing in this file imports @google/genai — the SDK is a lazy
// import inside generateThumbnailImage only, and the pure surface (decision,
// prompts, extraction) is what's under test.

const concept: ThumbnailConcept = {
  scene: "A developer at a glowing terminal, one giant agent icon looming behind",
  overlayText: "AGENTS EXPLAINED",
  styleNotes: "Deep blue palette, rim lighting, cinematic contrast",
};

describe("thumbnailDecision", () => {
  it("generates only when every precondition holds", () => {
    expect(thumbnailDecision(true, "/p/face.png", true, true)).toBe("generate");
  });

  // Full matrix, ordered by how early the user could have known (the
  // function's own precedence): feature off > never configured > no key >
  // runtime surprise.
  it("youtube off wins over everything — the whole feature is opt-in", () => {
    expect(thumbnailDecision(false, "/p/face.png", true, true)).toBe("skip-no-youtube");
    expect(thumbnailDecision(false, undefined, false, false)).toBe("skip-no-youtube");
  });

  it("no portrait path beats no key — it's the earlier-known gap", () => {
    expect(thumbnailDecision(true, undefined, false, false)).toBe("skip-no-portrait");
    expect(thumbnailDecision(true, undefined, true, false)).toBe("skip-no-portrait");
  });

  it("no key beats a missing file — existence is moot without credentials", () => {
    expect(thumbnailDecision(true, "/p/face.png", false, true)).toBe("skip-no-key");
    expect(thumbnailDecision(true, "/p/face.png", false, false)).toBe("skip-no-key");
  });

  it("a configured portrait that isn't on disk is its own loud reason", () => {
    expect(thumbnailDecision(true, "/p/face.png", true, false)).toBe("skip-portrait-missing");
  });
});

describe("portraitMimeType", () => {
  it("maps the four accepted extensions", () => {
    expect(portraitMimeType("/p/face.png")).toBe("image/png");
    expect(portraitMimeType("/p/face.jpg")).toBe("image/jpeg");
    expect(portraitMimeType("/p/face.jpeg")).toBe("image/jpeg");
    expect(portraitMimeType("/p/face.webp")).toBe("image/webp");
  });

  it("is case-insensitive on the extension", () => {
    expect(portraitMimeType("/p/FACE.PNG")).toBe("image/png");
    expect(portraitMimeType("/p/face.Jpg")).toBe("image/jpeg");
  });

  it("anything outside the table is undefined — never a guessed mime", () => {
    expect(portraitMimeType("/p/face.heic")).toBeUndefined();
    expect(portraitMimeType("/p/face.gif")).toBeUndefined();
    expect(portraitMimeType("/p/face")).toBeUndefined();
  });

  it("a dotted directory is not an extension (artifactPath's own lesson)", () => {
    expect(portraitMimeType("/out.png/face")).toBeUndefined();
  });

  it("the table itself carries exactly the documented formats", () => {
    expect(Object.keys(PORTRAIT_MIME_TYPES).sort()).toEqual(["jpeg", "jpg", "png", "webp"]);
  });
});

describe("ThumbnailConceptSchema", () => {
  it("parses a full concept", () => {
    expect(ThumbnailConceptSchema.parse(concept)).toEqual(concept);
  });

  // §112 as applied in beats.ts: over-budget text costs words, never the run.
  it("caps over-length fields instead of refusing", () => {
    const parsed = ThumbnailConceptSchema.parse({
      scene: "word ".repeat(100),
      overlayText: "punchy ".repeat(20),
      styleNotes: "moody ".repeat(100),
    });
    expect(parsed.scene.length).toBeLessThanOrEqual(300);
    expect(parsed.overlayText.length).toBeLessThanOrEqual(60);
    expect(parsed.styleNotes.length).toBeLessThanOrEqual(300);
  });

  it("a missing field is a real refusal — that IS malformed output", () => {
    expect(() => ThumbnailConceptSchema.parse({ scene: "s", styleNotes: "n" })).toThrow();
  });
});

describe("ThumbnailConceptApprovedSchema", () => {
  // The approved-file union (thumbnail UX, 2026-08-16): a concept the user
  // approved, or the explicit {skip: true} the "skip thumbnail" answer
  // records — both must round-trip, and garbage must refuse.
  it("parses both variants and refuses anything else", () => {
    expect(ThumbnailConceptApprovedSchema.parse(concept)).toEqual(concept);
    expect(ThumbnailConceptApprovedSchema.parse({ skip: true })).toEqual({ skip: true });
    expect(() => ThumbnailConceptApprovedSchema.parse({ skip: false })).toThrow();
    expect(() => ThumbnailConceptApprovedSchema.parse({})).toThrow();
  });
});

describe("buildThumbnailConceptPrompt", () => {
  const base = { transcriptText: "hello agents world" };

  it("includes hook and intent when given", () => {
    const { user } = buildThumbnailConceptPrompt({
      ...base,
      hook: "MOCK HOOK",
      intent: "educational video about agents",
    });
    expect(user).toContain("Intent: educational video about agents");
    expect(user).toContain("Hook (already chosen by the producer): MOCK HOOK");
    expect(user).toContain("Transcript:\nhello agents world");
  });

  it("omits the lines a run without --produce cannot supply", () => {
    const { user } = buildThumbnailConceptPrompt(base);
    expect(user).not.toContain("Intent:");
    expect(user).not.toContain("Hook");
  });

  it("caps the transcript at ~4k chars and says the video continues", () => {
    const { user } = buildThumbnailConceptPrompt({
      transcriptText: "x".repeat(THUMBNAIL_TRANSCRIPT_CHAR_CAP + 500),
    });
    expect(user).toContain("[transcript truncated — the video continues]");
    expect((user.match(/x+/) ?? [""])[0]).toHaveLength(THUMBNAIL_TRANSCRIPT_CHAR_CAP);
  });

  it("a transcript at the cap passes through without the truncation note", () => {
    const { user } = buildThumbnailConceptPrompt({
      transcriptText: "x".repeat(THUMBNAIL_TRANSCRIPT_CHAR_CAP),
    });
    expect(user).not.toContain("[transcript truncated");
  });

  it("the system prompt states the craft rules the schema cannot", () => {
    const { system } = buildThumbnailConceptPrompt(base);
    expect(system).toContain("thumbnail strategist");
    expect(system).toMatch(/ONE vivid scene/);
    expect(system).toMatch(/3-6 punchy words/);
  });

  // The pose conflict fix (debugged 2026-08-16): the reference photo is
  // frontal, arms crossed, and a concept saying "holding his head in
  // frustration" made the image model follow the scene's choreography over
  // the keep-pose rule. The fix starts at the CONCEPT — pinned so a rewrite
  // can't drop the rule back out.
  it("the system prompt forbids choreographing the person — design AROUND them", () => {
    const { system } = buildThumbnailConceptPrompt(base);
    expect(system).toContain("pose CANNOT change");
    expect(system).toContain("Design the scene AROUND the person");
    expect(system).toContain("never choreograph the person's body or hands");
  });

  // The steer matrix (thumbnail UX, 2026-08-16): audience, the must-honor
  // brief, the pack's title angle and the per-call regenerate note — each
  // present exactly when supplied.
  it("includes audience, brief, titleAngle and note when given", () => {
    const { user } = buildThumbnailConceptPrompt({
      ...base,
      audience: "junior web devs",
      brief: "always show the terminal",
      titleAngle: "How agents actually work",
      note: "less abstract",
    });
    expect(user).toContain("Audience: junior web devs");
    expect(user).toContain("Creator brief (must be honored): always show the terminal");
    expect(user).toContain(
      "Video title (already chosen — the thumbnail must tell the same story): " +
        "How agents actually work",
    );
    expect(user).toContain("Creator note (must be honored): less abstract");
  });

  it("omits the steer lines a bare run cannot supply", () => {
    const { user } = buildThumbnailConceptPrompt(base);
    expect(user).not.toContain("Audience:");
    expect(user).not.toContain("Creator brief");
    expect(user).not.toContain("Video title");
    expect(user).not.toContain("Creator note");
  });
});

describe("buildThumbnailPrompt", () => {
  it("bakes the fixed craft rules in", () => {
    const prompt = buildThumbnailPrompt(concept, true);
    expect(prompt).toContain("16:9 landscape, at least 1280x720");
    expect(prompt).toContain("No watermarks, no logos, no borders");
    expect(prompt).toContain("320px wide");
    expect(prompt).toContain(`Scene: ${concept.scene}`);
    expect(prompt).toContain(`Style: ${concept.styleNotes}`);
  });

  it("the overlay text rides VERBATIM, on its own line away from the instruction", () => {
    // The first field run (2026-08-16) used `reading EXACTLY: "…"` inline and
    // the model painted "EXACTLY:" into the thumbnail as a headline — the
    // instruction word must never touch the string it introduces.
    const prompt = buildThumbnailPrompt(concept, false);
    expect(prompt).toContain("\n  AGENTS EXPLAINED");
    expect(prompt).not.toMatch(/EXACTLY.*AGENTS EXPLAINED/);
  });

  it("with a portrait: identity is the hard constraint (user directive 2026-08-16)", () => {
    // The first generation produced a face that "isn't me" — the prompt now
    // makes facial accuracy the overriding rule, pinned here so a rewrite
    // can't soften it back into a one-line "preserve likeness" aside.
    const prompt = buildThumbnailPrompt(concept, true);
    expect(prompt).toContain("The person in the reference photo MUST appear");
    expect(prompt).toContain("left or right third");
    expect(prompt).toContain("100% accuracy");
    expect(prompt).toContain("ground truth for identity");
    expect(prompt).toContain("head pose, angle and framing of the face as close to the reference");
    expect(prompt).toContain("facial accuracy wins");
  });

  it("without a portrait: no reference-photo rule at all", () => {
    const prompt = buildThumbnailPrompt(concept, false);
    expect(prompt).not.toContain("reference photo");
    expect(prompt).not.toContain("likeness");
  });

  // The pose incident's image-side fix (debugged 2026-08-16): the identity
  // block must come FIRST — with it buried under Scene/Style, the model
  // followed the concept's choreography over the keep-pose rule.
  it("the identity block precedes Scene/Style, and the scene adapts to the person", () => {
    const prompt = buildThumbnailPrompt(concept, true);
    const identityAt = prompt.indexOf("The person in the reference photo MUST appear");
    const sceneAt = prompt.indexOf(`Scene: ${concept.scene}`);
    expect(identityAt).toBeGreaterThanOrEqual(0);
    expect(sceneAt).toBeGreaterThanOrEqual(0);
    expect(identityAt).toBeLessThan(sceneAt);
    expect(prompt).toContain(
      "The scene adapts to the person; never re-pose, re-angle, or choreograph the person " +
        "to fit the scene.",
    );
    // Without a portrait there is no person for the scene to adapt to.
    expect(buildThumbnailPrompt(concept, false)).not.toContain("scene adapts to the person");
  });

  // The retry loop's one input (thumbnail UX, 2026-08-16): the note rides
  // the image prompt only, marked must-honor, appended last.
  it("a revision note appends as the prompt's final must-honor line", () => {
    const prompt = buildThumbnailPrompt(concept, true, "warmer lighting");
    expect(prompt.trimEnd().split("\n").at(-1)).toBe(
      "Revision note from the creator (must be honored): warmer lighting",
    );
    expect(buildThumbnailPrompt(concept, true)).not.toContain("Revision note");
  });
});

describe("extractImageBytes", () => {
  // Plain objects, never the SDK: the whole point of isolating extraction is
  // that the response shape is exercised without @google/genai on the path.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  it("returns the first inlineData part's decoded bytes", () => {
    const bytes = extractImageBytes({
      candidates: [
        {
          content: {
            parts: [
              { text: "here is your thumbnail" },
              { inlineData: { data: png.toString("base64"), mimeType: "image/png" } },
              { inlineData: { data: Buffer.from("second").toString("base64") } },
            ],
          },
        },
      ],
    });
    expect(Buffer.from(bytes)).toEqual(png);
  });

  it("a text-only reply (model refusal) throws the no-image error", () => {
    expect(() =>
      extractImageBytes({
        candidates: [{ content: { parts: [{ text: "I cannot generate that" }] } }],
      }),
    ).toThrow(/no image/);
  });

  it("an empty or shape-drifted response throws rather than returning junk", () => {
    expect(() => extractImageBytes({})).toThrow(/no image/);
    expect(() => extractImageBytes(undefined)).toThrow(/no image/);
    expect(() => extractImageBytes({ candidates: [{}] })).toThrow(/no image/);
    expect(() =>
      extractImageBytes({ candidates: [{ content: { parts: [{ inlineData: { data: "" } }] } }] }),
    ).toThrow(/no image/);
  });
});

describe("generateThumbnailConcept", () => {
  it("asks the editorial tier for a thumbnail_concept", async () => {
    const calls: { schemaName: string; tier?: string }[] = [];
    const provider: LlmProvider = {
      name: "stub",
      usage: [],
      async complete<T>(req: { schema: z.ZodType<T>; schemaName: string; tier?: string }) {
        calls.push({ schemaName: req.schemaName, tier: req.tier });
        return req.schema.parse(concept);
      },
    };
    const got = await generateThumbnailConcept(provider, { transcriptText: "hello" });
    expect(calls).toEqual([{ schemaName: "thumbnail_concept", tier: "editorial" }]);
    expect(got).toEqual(concept);
  });
});

describe("THUMBNAIL_MODEL_DEFAULT", () => {
  it("is the user-specified slug (2026-08-16)", () => {
    expect(THUMBNAIL_MODEL_DEFAULT).toBe("gemini-3.1-flash-lite-image");
  });
});

describe("approvedOverlayText", () => {
  it("caps a long overlay to the §35 word ceiling", () => {
    const capped = approvedOverlayText(
      "this agent framework changes absolutely everything about how teams actually ship code",
    );
    expect(capped.split(" ").length).toBeLessThanOrEqual(9);
    expect(capped.length).toBeGreaterThan(0);
  });

  it("passes a short overlay through verbatim", () => {
    expect(approvedOverlayText("AGENTS EXPLAINED")).toBe("AGENTS EXPLAINED");
  });

  it("an overlay coverHeadline rejects outright survives as typed, never empty", () => {
    // coverHeadline returns "" for whitespace-only input, and the raw text
    // must stand — a user-typed overlay silently becoming empty is worse
    // than an odd one (the `|| raw` branch).
    expect(approvedOverlayText("  ")).toBe("  ");
  });
});

describe("thumbnailImageCacheName", () => {
  it("is deterministic and keyed on model, concept and portrait content", () => {
    const name = thumbnailImageCacheName("m1", concept, "sha-a");
    expect(name).toBe(thumbnailImageCacheName("m1", concept, "sha-a"));
    expect(name).toMatch(/^thumbnail-[0-9a-f]{8}\.png$/);
    expect(thumbnailImageCacheName("m2", concept, "sha-a")).not.toBe(name);
    expect(
      thumbnailImageCacheName("m1", { ...concept, overlayText: "OTHER" }, "sha-a"),
    ).not.toBe(name);
    expect(thumbnailImageCacheName("m1", concept, "sha-b")).not.toBe(name);
  });

  it("pins the concept's field order — a reordered caller literal cannot re-key", () => {
    // Two spellings of one concept (thumbnailStep's schema-ordered object vs
    // a hand-built literal) must land on ONE cache file, or the produce
    // replay pays for an image the editor already generated.
    const reordered = {
      styleNotes: concept.styleNotes,
      scene: concept.scene,
      overlayText: concept.overlayText,
    } as ThumbnailConcept;
    expect(thumbnailImageCacheName("m1", reordered, "sha-a")).toBe(
      thumbnailImageCacheName("m1", concept, "sha-a"),
    );
  });
});
