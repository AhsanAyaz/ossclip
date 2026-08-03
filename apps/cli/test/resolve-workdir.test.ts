import { describe, expect, it } from "vitest";
import { resolveWorkdir, type WorkdirProbe } from "../src/interactive/resolve-workdir";

const probe = (over: Partial<WorkdirProbe> = {}): WorkdirProbe => ({
  isWorkdir: false,
  candidates: [],
  ...over,
});

describe("resolveWorkdir", () => {
  it("takes a directory that is already a workdir", () => {
    const r = resolveWorkdir("/v/.ossclip/take-abc", probe({ isWorkdir: true }));
    expect(r).toEqual({ kind: "resolved", workdir: "/v/.ossclip/take-abc", via: "direct" });
  });

  // The reported bug: `ossclip edit D:\CWA\TiDB` when the only run lives at
  // D:\CWA\TiDB\.ossclip\<name>. One candidate is not a choice to make.
  it("descends into .ossclip when exactly one run is there", () => {
    const r = resolveWorkdir("/v", probe({ candidates: [{ path: "/v/.ossclip/take-abc", mtimeMs: 5 }] }));
    expect(r).toEqual({ kind: "resolved", workdir: "/v/.ossclip/take-abc", via: "nested" });
  });

  it("asks when several runs are there, newest first", () => {
    const r = resolveWorkdir(
      "/v",
      probe({
        candidates: [
          { path: "/v/.ossclip/old", mtimeMs: 1 },
          { path: "/v/.ossclip/new", mtimeMs: 9 },
          { path: "/v/.ossclip/mid", mtimeMs: 5 },
        ],
      }),
    );
    expect(r.kind).toBe("choose");
    if (r.kind !== "choose") throw new Error("unreachable");
    expect(r.candidates.map((c) => c.path)).toEqual([
      "/v/.ossclip/new",
      "/v/.ossclip/mid",
      "/v/.ossclip/old",
    ]);
  });

  it("prefers being a workdir over descending", () => {
    // A workdir that itself contains an .ossclip (nested produce runs) must
    // not be skipped over in favour of its children.
    const r = resolveWorkdir(
      "/v",
      probe({ isWorkdir: true, candidates: [{ path: "/v/.ossclip/take", mtimeMs: 1 }] }),
    );
    expect(r).toEqual({ kind: "resolved", workdir: "/v", via: "direct" });
  });

  it("explains the layout and points at the picker when nothing is there", () => {
    const r = resolveWorkdir("/v", probe());
    expect(r.kind).toBe("none");
    if (r.kind !== "none") throw new Error("unreachable");
    // The old message said "run `ossclip produce` there first" to a user who
    // had. The new one must name the nesting AND the picker.
    expect(r.message).toContain("/v");
    expect(r.message).toContain(".ossclip");
    expect(r.message).toContain("ossclip edit");
  });

  it("writes the layout hint with the host's separator", () => {
    const r = resolveWorkdir("D:\\TiDB", probe(), "\\");
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("\\.ossclip\\");
    expect(r.message).not.toContain("/.ossclip/");
  });
});
