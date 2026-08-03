import { describe, expect, it } from "vitest";
import { candidateListMessage, resolveWorkdir, type WorkdirProbe } from "../src/interactive/resolve-workdir";

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

  // The founding bug, twice over: a path that does not exist and a path that
  // cannot be read were both reported as "no ossclip output — run produce".
  it("says so when the path does not exist, and still names the picker", () => {
    const r = resolveWorkdir("/v/typo.mp4", probe({ reason: "missing", code: "ENOENT" }));
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("no such path: /v/typo.mp4");
    expect(r.message).toContain("ossclip edit");
    // Never "produce into <the typo>/your-video.mp4" — a path that can never exist.
    expect(r.message).not.toContain("ossclip produce");
  });

  it("says permissions, not produce, when the path cannot be read", () => {
    const r = resolveWorkdir("/v", probe({ reason: "unreadable", code: "EACCES" }));
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("can't read /v");
    expect(r.message).toContain("EACCES");
    expect(r.message).toContain("permissions");
    // The run may be right there — telling them to redo it is the old bug.
    expect(r.message).not.toContain("ossclip produce");
  });

  it("names an unexpected errno rather than guessing at a cause", () => {
    const r = resolveWorkdir("/v", probe({ reason: "unreadable", code: "ELOOP" }));
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("ELOOP");
  });

  it("keeps the layout explanation for a readable, empty folder", () => {
    const r = resolveWorkdir("/v", probe());
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("no ossclip output under /v");
  });

  it("writes the layout hint with the host's separator", () => {
    const r = resolveWorkdir("D:\\TiDB", probe(), "\\");
    if (r.kind !== "none") throw new Error("unreachable");
    expect(r.message).toContain("\\.ossclip\\");
    expect(r.message).not.toContain("/.ossclip/");
  });
});

describe("candidateListMessage", () => {
  it("renders one pasteable command per candidate", () => {
    const msg = candidateListMessage("/v", [
      { path: "/v/.ossclip/new", mtimeMs: 9 },
      { path: "/v/.ossclip/old", mtimeMs: 1 },
    ]);
    expect(msg).toContain("several produce runs under /v");
    expect(msg).toContain("  ossclip edit /v/.ossclip/new");
    expect(msg).toContain("  ossclip edit /v/.ossclip/old");
  });

  // The whole point of this branch: the line must survive a paste. An
  // unquoted path with a space arrives at the shell as two arguments.
  it("quotes a candidate path containing a space", () => {
    const msg = candidateListMessage("/v", [
      { path: "/v/My Videos/.ossclip/take-a", mtimeMs: 1 },
    ]);
    expect(msg).toContain("ossclip edit '/v/My Videos/.ossclip/take-a'");
  });
});
