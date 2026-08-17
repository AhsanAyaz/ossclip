import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateThumbnailImageOptions, LlmProvider } from "@ossclip/core";
import { thumbnailStep, type ThumbnailStepArgs } from "../src/produce";

/**
 * The Y3 orchestration matrix, exercised through the injected `generate`
 * seam (pickCoverFrame's detectFace shape): cache hit/miss, portrait content
 * identity, and the degrade-to-cover contract — all without @google/genai
 * ever being imported, an API key, or a network.
 */

const concept = {
  scene: "A developer at a glowing terminal",
  overlayText: "AGENTS EXPLAINED",
  styleNotes: "Deep blue palette, rim lighting",
};

const stubProvider = (calls?: { schemaName: string }[]): LlmProvider => ({
  name: "stub",
  usage: [],
  async complete<T>(req: { schema: { parse: (v: unknown) => T }; schemaName: string }) {
    calls?.push({ schemaName: req.schemaName });
    return req.schema.parse(concept);
  },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ossclip-thumb-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function baseArgs(over: Partial<ThumbnailStepArgs> = {}): ThumbnailStepArgs {
  const portraitPath = join(dir, "face.png");
  if (!existsSync(portraitPath)) writeFileSync(portraitPath, "portrait-bytes-v1");
  return {
    youtube: true,
    portraitPath,
    apiKey: "test-key",
    model: "gemini-3.1-flash-lite-image",
    work: dir,
    outPath: join(dir, "final.mp4"),
    provider: stubProvider(),
    providerName: "stub",
    llmModel: undefined,
    intent: undefined,
    hook: "MOCK HOOK",
    transcriptWords: ["hello", "agents"],
    log: () => {},
    ...over,
  };
}

describe("thumbnailStep", () => {
  it("generates, caches in the workdir and copies beside the output", async () => {
    const seen: GenerateThumbnailImageOptions[] = [];
    const got = await thumbnailStep(
      baseArgs({
        generate: async (opts) => {
          seen.push(opts);
          return IMAGE;
        },
      }),
    );
    expect(got?.path).toBe(join(dir, "final.thumbnail.png"));
    expect(Array.from(readFileSync(got!.path))).toEqual(Array.from(IMAGE));
    // The retry loop's inputs ride the result: the exact concept prompted,
    // the cache file it overwrites, and the portrait inlineData.
    expect(got?.concept.overlayText).toBe("AGENTS EXPLAINED");
    expect(got?.imageCachePath).toMatch(/thumbnail-[0-9a-f]{8}\.png$/);
    expect(got?.portrait).toEqual({
      data: Buffer.from("portrait-bytes-v1").toString("base64"),
      mimeType: "image/png",
    });
    // Workdir holds both caches: the concept JSON and the image bytes.
    const names = readdirSync(dir);
    expect(names.some((n) => /^thumbnail-concept-[0-9a-f]{8}\.json$/.test(n))).toBe(true);
    expect(names.some((n) => /^thumbnail-[0-9a-f]{8}\.png$/.test(n))).toBe(true);
    // The generate call carried the portrait as base64 inlineData and the
    // overlay text verbatim in the prompt.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.portrait).toEqual({
      data: Buffer.from("portrait-bytes-v1").toString("base64"),
      mimeType: "image/png",
    });
    // Own-line verbatim overlay — the inline `EXACTLY: "…"` phrasing leaked
    // the word "EXACTLY:" into a generated image (field run 2026-08-16).
    expect(seen[0]!.prompt).toContain("\n  AGENTS EXPLAINED");
    expect(seen[0]!.apiKey).toBe("test-key");
    expect(seen[0]!.model).toBe("gemini-3.1-flash-lite-image");
  });

  it("a second identical run is a full cache hit — zero generate calls", async () => {
    let generateCalls = 0;
    let conceptCalls = 0;
    const provider: LlmProvider = {
      name: "stub",
      usage: [],
      async complete<T>(req: { schema: { parse: (v: unknown) => T } }) {
        conceptCalls += 1;
        return req.schema.parse(concept);
      },
    };
    const generate = async () => {
      generateCalls += 1;
      return IMAGE;
    };
    await thumbnailStep(baseArgs({ provider, generate }));
    const again = await thumbnailStep(baseArgs({ provider, generate }));
    expect(again?.path).toBe(join(dir, "final.thumbnail.png"));
    expect(conceptCalls).toBe(1);
    expect(generateCalls).toBe(1);
  });

  it("changed portrait BYTES at the same path regenerate the image", async () => {
    let generateCalls = 0;
    const generate = async () => {
      generateCalls += 1;
      return IMAGE;
    };
    const args = baseArgs({ generate });
    await thumbnailStep(args);
    // Same path, new content — the key hashes bytes, not the path or mtime.
    writeFileSync(args.portraitPath!, "portrait-bytes-v2");
    await thumbnailStep(baseArgs({ generate }));
    expect(generateCalls).toBe(2);
  });

  it("an API error degrades loudly: no cache, no artifact, run continues", async () => {
    const lines: string[] = [];
    const got = await thumbnailStep(
      baseArgs({
        generate: async () => {
          // The verbatim-surface contract (§132 posture): an unknown-model
          // rejection must reach the user in the API's own words.
          throw new Error("models/gemini-3.1-flash-lite-image is not found");
        },
        log: (l) => lines.push(l),
      }),
    );
    expect(got).toBeUndefined();
    expect(lines.join("\n")).toContain(
      "generation failed (models/gemini-3.1-flash-lite-image is not found)",
    );
    expect(lines.join("\n")).toContain("frame-grab cover stands");
    expect(existsSync(join(dir, "final.thumbnail.png"))).toBe(false);
    // Failure NEVER cached (§106): no thumbnail-<key>.png in the workdir, and
    // the next run retries the image call.
    expect(readdirSync(dir).some((n) => /^thumbnail-[0-9a-f]{8}\.png$/.test(n))).toBe(false);
    let retried = 0;
    await thumbnailStep(
      baseArgs({
        generate: async () => {
          retried += 1;
          return IMAGE;
        },
      }),
    );
    expect(retried).toBe(1);
  });

  it("a concept failure degrades the same way and is not cached", async () => {
    const failing: LlmProvider = {
      name: "stub",
      usage: [],
      async complete(): Promise<never> {
        throw new Error("rate limited");
      },
    };
    const lines: string[] = [];
    const got = await thumbnailStep(
      baseArgs({ provider: failing, generate: async () => IMAGE, log: (l) => lines.push(l) }),
    );
    expect(got).toBeUndefined();
    expect(lines.join("\n")).toContain("concept failed (rate limited)");
    expect(readdirSync(dir).some((n) => n.startsWith("thumbnail-concept-"))).toBe(false);
  });

  it("skips per the decision matrix, loud with a reason, generate untouched", async () => {
    let called = 0;
    const generate = async () => {
      called += 1;
      return IMAGE;
    };
    const collect = () => {
      const lines: string[] = [];
      return { lines, log: (l: string) => lines.push(l) };
    };

    const noKey = collect();
    expect(
      await thumbnailStep(baseArgs({ apiKey: undefined, generate, log: noKey.log })),
    ).toBeUndefined();
    expect(noKey.lines.join("\n")).toContain("GEMINI_API_KEY not set");

    const noPortrait = collect();
    expect(
      await thumbnailStep(baseArgs({ portraitPath: undefined, generate, log: noPortrait.log })),
    ).toBeUndefined();
    expect(noPortrait.lines.join("\n")).toContain("no portrait");

    const missing = collect();
    expect(
      await thumbnailStep(
        baseArgs({ portraitPath: join(dir, "nope.png"), generate, log: missing.log }),
      ),
    ).toBeUndefined();
    expect(missing.lines.join("\n")).toContain(`portrait not found: ${join(dir, "nope.png")}`);

    expect(called).toBe(0);
  });

  it("youtube off is the one SILENT skip — the user never opted in", async () => {
    const lines: string[] = [];
    expect(
      await thumbnailStep(baseArgs({ youtube: false, log: (l) => lines.push(l) })),
    ).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("an unsupported portrait format is a loud skip, never a guessed mime", async () => {
    const heic = join(dir, "face.heic");
    writeFileSync(heic, "heic-bytes");
    const lines: string[] = [];
    let called = 0;
    expect(
      await thumbnailStep(
        baseArgs({
          portraitPath: heic,
          generate: async () => {
            called += 1;
            return IMAGE;
          },
          log: (l) => lines.push(l),
        }),
      ),
    ).toBeUndefined();
    expect(lines.join("\n")).toContain("unsupported portrait format");
    expect(called).toBe(0);
  });

  it("audience/brief/titleAngle reach the concept prompt and re-key the concept cache", async () => {
    const users: string[] = [];
    const provider: LlmProvider = {
      name: "stub",
      usage: [],
      async complete<T>(req: { user: string; schema: { parse: (v: unknown) => T } }) {
        users.push(req.user);
        return req.schema.parse(concept);
      },
    };
    const generate = async () => IMAGE;
    await thumbnailStep(
      baseArgs({
        provider,
        generate,
        audience: "junior devs",
        brief: "always show the terminal",
        titleAngle: "How agents actually work",
      }),
    );
    expect(users[0]).toContain("Audience: junior devs");
    expect(users[0]).toContain("Creator brief (must be honored): always show the terminal");
    expect(users[0]).toContain("How agents actually work");
    // A changed steer is a different concept, never a cache hit.
    await thumbnailStep(baseArgs({ provider, generate, audience: "engineering managers" }));
    expect(users).toHaveLength(2);
  });

  // The pre-render approval contract (thumbnail UX, 2026-08-16): once
  // thumbnail-concept-approved.json exists, the step uses it VERBATIM — the
  // user approved (and possibly edited) that text before the render, and a
  // fresh concept call would discard their edit.
  it("an approved concept is used verbatim — zero concept calls, no provider needed", async () => {
    const approved = {
      scene: "The creator beside a wall of green terminal output",
      overlayText: "USER APPROVED",
      styleNotes: "Warm rim light",
    };
    writeFileSync(join(dir, "thumbnail-concept-approved.json"), JSON.stringify(approved));
    const conceptCalls: { schemaName: string }[] = [];
    const seen: GenerateThumbnailImageOptions[] = [];
    const got = await thumbnailStep(
      baseArgs({
        provider: stubProvider(conceptCalls),
        generate: async (opts) => {
          seen.push(opts);
          return IMAGE;
        },
      }),
    );
    expect(got?.path).toBe(join(dir, "final.thumbnail.png"));
    expect(got?.concept).toEqual(approved);
    expect(conceptCalls).toEqual([]);
    // No concept cache is written either — the approved file IS the concept.
    expect(readdirSync(dir).some((n) => /^thumbnail-concept-[0-9a-f]{8}\.json$/.test(n))).toBe(
      false,
    );
    expect(seen[0]!.prompt).toContain("\n  USER APPROVED");
    // And a run WITHOUT a text provider still generates: approval already
    // answered the only question the provider was needed for.
    rmSync(join(dir, "final.thumbnail.png"));
    const noProvider = await thumbnailStep(
      baseArgs({ provider: undefined, generate: async () => IMAGE }),
    );
    expect(noProvider?.path).toBe(join(dir, "final.thumbnail.png"));
  });

  it("an approved {skip: true} is a LOUD skip that names the escape hatch", async () => {
    writeFileSync(join(dir, "thumbnail-concept-approved.json"), JSON.stringify({ skip: true }));
    const lines: string[] = [];
    let called = 0;
    const got = await thumbnailStep(
      baseArgs({
        generate: async () => {
          called += 1;
          return IMAGE;
        },
        log: (l) => lines.push(l),
      }),
    );
    expect(got).toBeUndefined();
    expect(called).toBe(0);
    expect(lines.join("\n")).toContain("declined at concept approval");
    expect(lines.join("\n")).toContain("thumbnail-concept-approved.json");
    expect(lines.join("\n")).toContain("frame-grab cover stands");
  });

  it("no LLM provider means no concept, said out loud", async () => {
    const lines: string[] = [];
    let called = 0;
    expect(
      await thumbnailStep(
        baseArgs({
          provider: undefined,
          generate: async () => {
            called += 1;
            return IMAGE;
          },
          log: (l) => lines.push(l),
        }),
      ),
    ).toBeUndefined();
    expect(lines.join("\n")).toContain("no LLM provider for the concept");
    expect(called).toBe(0);
  });
});
