import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOLDER_CAP,
  SAVE_DEFAULT,
  SAVE_HERE,
  SAVE_TYPE_PATH,
  SAVE_UP,
  normalizeOutName,
  pickSavePath,
  savePathOptions,
  type DirEntry,
  type SavePathPrompts,
} from "../src/interactive/pick-save-path";

/**
 * The output-file folder walk (2026-08-16, the `~`-path incident's second
 * defense). Shaping and normalization are pure; the loop is driven through
 * the injectable SavePathPrompts seam exactly as thumbnail-approve.test.ts
 * drives its ApprovePrompts — scripted answers in, a path (or the use-default
 * undefined) out, no TTY, no clack, no filesystem.
 */

const d = (name: string): DirEntry => ({ name, isDir: true });
const f = (name: string): DirEntry => ({ name, isDir: false });

describe("savePathOptions", () => {
  it("folders only, hidden omitted, codepoint-sorted", () => {
    const rows = savePathOptions([f("take.mp4"), d("zeta"), d(".git"), d("alpha"), f(".DS_Store")], {
      dir: "/vids",
      atRoot: false,
    });
    expect(rows.map((r) => r.value)).toEqual([
      SAVE_HERE,
      SAVE_UP,
      join("/vids", "alpha"),
      join("/vids", "zeta"),
      SAVE_TYPE_PATH,
    ]);
  });

  it("the default row leads when offered — it is the plain-Enter fast path", () => {
    const rows = savePathOptions([], { dir: "/vids", atRoot: false, defaultName: "take.ossclip.mp4" });
    expect(rows[0]?.value).toBe(SAVE_DEFAULT);
    expect(rows[0]?.label).toBe("use default: take.ossclip.mp4");
  });

  it("no '..' at the filesystem root — there is nowhere up to go", () => {
    const rows = savePathOptions([], { dir: "/", atRoot: true });
    expect(rows.map((r) => r.value)).toEqual([SAVE_HERE, SAVE_TYPE_PATH]);
  });

  it("caps the folder list and turns the escape row's hint into the overflow notice", () => {
    const many = Array.from({ length: FOLDER_CAP + 5 }, (_, i) =>
      d(`folder-${String(i).padStart(2, "0")}`),
    );
    const rows = savePathOptions(many, { dir: "/vids", atRoot: false });
    const folderRows = rows.filter((r) => !r.value.startsWith("__"));
    expect(folderRows).toHaveLength(FOLDER_CAP);
    expect(rows.at(-1)?.value).toBe(SAVE_TYPE_PATH);
    expect(rows.at(-1)?.hint).toBe("5 more folders not shown");
  });

  it("folder row values are absolute — a folder named like a sentinel cannot collide", () => {
    const rows = savePathOptions([d("__save_here__")], { dir: "/vids", atRoot: false });
    const folder = rows.find((r) => r.label === "__save_here__/");
    expect(folder?.value).toBe(join("/vids", "__save_here__"));
  });
});

describe("normalizeOutName", () => {
  it("refuses empty and whitespace", () => {
    expect(normalizeOutName(undefined)).toEqual({ ok: false, problem: "a file name is required" });
    expect(normalizeOutName("")).toEqual({ ok: false, problem: "a file name is required" });
    expect(normalizeOutName("   ")).toEqual({ ok: false, problem: "a file name is required" });
  });

  it("refuses a path separator — the folder was picked above, not here", () => {
    expect(normalizeOutName("sub/final").ok).toBe(false);
    expect(normalizeOutName("sub\\final").ok).toBe(false);
  });

  it("appends .mp4 only when there is NO dot-extension", () => {
    expect(normalizeOutName("video")).toEqual({ ok: true, name: "video.mp4" });
    expect(normalizeOutName("  video  ")).toEqual({ ok: true, name: "video.mp4" });
  });

  it("keeps an existing extension — including a typo'd one (parse, don't coerce)", () => {
    expect(normalizeOutName("video.mov")).toEqual({ ok: true, name: "video.mov" });
    // The .mp5 stays and is the user's: silently "fixing" it is the exact
    // coercion the house zod rule exists to prevent.
    expect(normalizeOutName("video.mp5")).toEqual({ ok: true, name: "video.mp5" });
  });
});

describe("pickSavePath (walk logic)", () => {
  const start = resolve("/vids/raw");

  interface Harness {
    prompts: SavePathPrompts;
    /** Each select's options — screen count and per-screen rows in one place. */
    screens: { value: string; label: string; hint?: string }[][];
    /** Each text prompt's opts, so the prefill contract is assertable. */
    textOpts: { message: string; initialValue?: string; placeholder?: string }[];
    listEntries: (dir: string) => DirEntry[];
  }

  const harness = (script: {
    selects: string[];
    texts?: string[];
    listings?: Record<string, DirEntry[]>;
  }): Harness => {
    const selects = [...script.selects];
    const texts = [...(script.texts ?? [])];
    const h: Harness = {
      screens: [],
      textOpts: [],
      listEntries: (dir) => script.listings?.[dir] ?? [],
      prompts: {
        select: async (opts) => {
          h.screens.push(opts.options);
          const next = selects.shift();
          // Running past the script means the loop asked a question the test
          // never planned — a hang in production, so fail loudly instead.
          if (next === undefined) throw new Error("select called past the script");
          return next;
        },
        text: async (opts) => {
          h.textOpts.push(opts);
          const next = texts.shift();
          if (next === undefined) throw new Error("text called past the script");
          // The real prompt will not return a value its own validator
          // rejects, so a fake that does would test an unreachable state
          // (ask-input.test.ts's rule).
          const problem = opts.validate?.(next);
          if (problem !== undefined) throw new Error(`scripted answer rejected: ${problem}`);
          return next;
        },
      },
    };
    return h;
  };

  const run = (h: Harness, defaultName = "take.ossclip.mp4") =>
    pickSavePath({ startDir: start, defaultName, prompts: h.prompts, listEntries: h.listEntries });

  it("use-default resolves undefined — the caller emits no --out (elision rule)", async () => {
    const h = harness({ selects: [SAVE_DEFAULT] });
    await expect(run(h)).resolves.toBeUndefined();
    expect(h.textOpts).toHaveLength(0);
  });

  it("save-here prefills the default name, and the answer lands in the current folder", async () => {
    const h = harness({ selects: [SAVE_HERE], texts: ["take.ossclip.mp4"] });
    await expect(run(h)).resolves.toBe(join(start, "take.ossclip.mp4"));
    // The prefill IS the plain-Enter contract: Enter on the name prompt must
    // reproduce the default file name, not an empty answer.
    expect(h.textOpts[0]?.initialValue).toBe("take.ossclip.mp4");
  });

  it("descends into a subfolder and assembles the path there, extension appended", async () => {
    const sub = join(start, "exports");
    const h = harness({
      selects: [sub, SAVE_HERE],
      texts: ["final"],
      listings: { [start]: [d("exports")] },
    });
    await expect(run(h)).resolves.toBe(join(sub, "final.mp4"));
    // The default row belongs to the start folder only — screen two is a
    // navigated-to folder where the default would NOT land.
    expect(h.screens[0]?.some((r) => r.value === SAVE_DEFAULT)).toBe(true);
    expect(h.screens[1]?.some((r) => r.value === SAVE_DEFAULT)).toBe(false);
  });

  it("'..' walks up, and returning to the start folder brings the default row back", async () => {
    const parent = dirname(start);
    const h = harness({
      selects: [SAVE_UP, start, SAVE_DEFAULT],
      listings: { [parent]: [d("raw")] },
    });
    await expect(run(h)).resolves.toBeUndefined();
    expect(h.screens[1]?.some((r) => r.value === SAVE_DEFAULT)).toBe(false);
    // Back in the start folder the fast path is honest again — the default
    // really does land here — so the row returns.
    expect(h.screens[2]?.some((r) => r.value === SAVE_DEFAULT)).toBe(true);
  });

  it("type-a-path expands ~ and resolves absolute — the incident this feature answers", async () => {
    const h = harness({ selects: [SAVE_TYPE_PATH], texts: ["~/Downloads/final.mp4"] });
    await expect(run(h)).resolves.toBe(join(homedir(), "Downloads", "final.mp4"));
  });
});
