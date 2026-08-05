import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertAllClipsHaveAudio,
  audioGuardMessage,
  buildConcatFilter,
  evaluateAudioProbes,
  folderManifestKey,
  planFolderConcat,
  probeClipsWithAudioGuard,
  type ConcatEntry,
} from "../src/concat";

/**
 * folder-input-brief.md: pointing `produce` at a folder concats its clips
 * first. These two functions are the PURE half of that feature (CLAUDE.md's
 * pure/IO split) — the regression test for the field bug that motivated the
 * split: a hand-built ffmpeg filtergraph corrupted by shell expansion (zsh
 * `:a`) left every concat slot silently playing clip 1's audio, because
 * nothing validated the filter STRING. `buildConcatFilter`'s label-uniqueness
 * assertions below are that validation.
 */

describe("planFolderConcat", () => {
  const entry = (name: string, mtimeMs: number, size = 100): ConcatEntry => ({ name, mtimeMs, size });

  it("sorts by name (default) as a plain codepoint sort, not locale collation", () => {
    const entries = [entry("clip10.mov", 3), entry("clip2.mov", 1), entry("Clip1.mov", 2)];
    // Plain codepoint order: uppercase 'C' (0x43) sorts before lowercase 'c'
    // (0x63) — a locale-aware sort would interleave them instead, and would
    // disagree with `ls` on a case-sensitive filesystem (the brief's spec).
    expect(planFolderConcat(entries, "name")).toEqual(["Clip1.mov", "clip10.mov", "clip2.mov"]);
  });

  it("sorts by mtime, oldest first", () => {
    const entries = [entry("c.mov", 300), entry("a.mov", 100), entry("b.mov", 200)];
    expect(planFolderConcat(entries, "mtime")).toEqual(["a.mov", "b.mov", "c.mov"]);
  });

  it("breaks an mtime tie by name — a batch copy often shares one timestamp", () => {
    const entries = [entry("z.mov", 100), entry("a.mov", 100), entry("m.mov", 100)];
    expect(planFolderConcat(entries, "mtime")).toEqual(["a.mov", "m.mov", "z.mov"]);
  });

  it("does not mutate its input", () => {
    const entries = [entry("b.mov", 2), entry("a.mov", 1)];
    const copy = [...entries];
    planFolderConcat(entries, "name");
    expect(entries).toEqual(copy);
  });
});

describe("buildConcatFilter", () => {
  it("gives every [i:v]/[i:a] input label exactly once, for n inputs", () => {
    const n = 11; // the field-bug folder's actual clip count
    const filter = buildConcatFilter(n, { w: 1080, h: 1920 });
    for (let i = 0; i < n; i++) {
      expect(filter.match(new RegExp(`\\[${i}:v\\]`, "g"))).toHaveLength(1);
      expect(filter.match(new RegExp(`\\[${i}:a\\]`, "g"))).toHaveLength(1);
    }
    // No stray 12th input reference — the exact regression the field bug was:
    // a slot that silently referenced input 0 again instead of its own index.
    expect(filter.match(/\[\d+:[va]\]/g)).toHaveLength(n * 2);
  });

  it("produces the documented concat tail: [v0][a0]…concat=n=N:v=1:a=1[outv][outa]", () => {
    const filter = buildConcatFilter(3, { w: 1080, h: 1920 });
    expect(filter).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[outv\]\[outa\]$/);
  });

  it("scale+pad target every video chain identically, letterboxing rather than cropping", () => {
    const filter = buildConcatFilter(2, { w: 1920, h: 1080 });
    // force_original_aspect_ratio=decrease + pad is the letterbox contract —
    // never crop, since produce's own framing decides crops later.
    const videoChains = filter.split(";").filter((c) => /\[v\d+\]$/.test(c));
    expect(videoChains).toHaveLength(2);
    for (const chain of videoChains) {
      expect(chain).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
      expect(chain).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
      expect(chain).toContain("fps=30");
      expect(chain).toContain("setsar=1");
      expect(chain).toContain("format=yuv420p");
    }
  });

  it("resamples every audio chain to 48kHz stereo", () => {
    const filter = buildConcatFilter(2, { w: 1080, h: 1920 });
    const audioChains = filter.split(";").filter((c) => /\[a\d+\]$/.test(c));
    expect(audioChains).toHaveLength(2);
    for (const chain of audioChains) {
      expect(chain).toContain("aresample=48000");
      expect(chain).toContain("aformat=channel_layouts=stereo");
    }
  });
});

describe("folderManifestKey (review fix — workdir must go stale with the folder's content)", () => {
  const entry = (name: string, mtimeMs: number, size = 100): ConcatEntry => ({ name, mtimeMs, size });

  it("is the SAME key regardless of enumeration order — `readdir` order is OS-dependent", () => {
    const a = [entry("a.mov", 1), entry("b.mov", 2), entry("c.mov", 3)];
    const b = [entry("c.mov", 3), entry("a.mov", 1), entry("b.mov", 2)];
    expect(folderManifestKey(a, "name")).toBe(folderManifestKey(b, "name"));
  });

  it("changes when a clip is added or removed — the pinned invariant: content change ⇒ different workdir", () => {
    const before = [entry("a.mov", 1), entry("b.mov", 2)];
    const after = [entry("a.mov", 1), entry("b.mov", 2), entry("c.mov", 3)];
    expect(folderManifestKey(before, "name")).not.toBe(folderManifestKey(after, "name"));
  });

  it("changes when a clip's size or mtime changes — a re-exported take under the same name", () => {
    const original = [entry("a.mov", 1000, 500)];
    const resizedClip = [entry("a.mov", 1000, 999)];
    const retimedClip = [entry("a.mov", 2000, 500)];
    const key = folderManifestKey(original, "name");
    expect(folderManifestKey(resizedClip, "name")).not.toBe(key);
    expect(folderManifestKey(retimedClip, "name")).not.toBe(key);
  });

  it("changes when --sort flips — the concat's actual byte order changes", () => {
    const entries = [entry("a.mov", 1), entry("b.mov", 2)];
    expect(folderManifestKey(entries, "name")).not.toBe(folderManifestKey(entries, "mtime"));
  });

  /**
   * Audit fix: the key used to be a `:`/`|` delimiter join over raw
   * filenames — user-controlled text that can contain both delimiters — so
   * two DIFFERENT entry sets could serialize identically and one folder
   * would silently reuse another's workdir caches. JSON serialization
   * escapes the filename instead of trusting it.
   */
  it("injection shape: delimiter characters in a filename cannot collide two different entry sets", () => {
    // Under the old `${name}:${size}:${mtimeMs}` join with `|` between
    // entries, ONE file named "a.mov:1:2|b.mov" (size 3, mtime 4) and TWO
    // files [a.mov size 1 mtime 2, b.mov size 3 mtime 4] both flattened to
    // the identical string "a.mov:1:2|b.mov:3:4" — two different folders,
    // one workdir, every cache silently shared.
    const one = [entry("a.mov:1:2|b.mov", 4, 3)];
    const two = [entry("a.mov", 2, 1), entry("b.mov", 4, 3)];
    expect(folderManifestKey(one, "name")).not.toBe(folderManifestKey(two, "name"));
  });

  /**
   * §131: a field report of workdir "drift" on an untouched folder turned out
   * to be a rename — the two runs' recorded source-concat.json manifests held
   * IDENTICAL sizes and mtimes but different names (camera-export UUIDs, then
   * `1`–`4`), and under `--sort name` the rename also changed the concat
   * order, so re-keying was mandatory, not a bug. mtimes were the suspect
   * (iCloud-synced Downloads) and were exonerated byte-for-byte. Pinned with
   * the recorded values, deriving the exact observed workdir hashes the same
   * way produce.ts does, so the next "same folder, different workdir" report
   * can be checked here instead of re-litigated from suspicion.
   */
  it("§131 field case: a rename alone (same sizes, same mtimes) re-keys; an unchanged manifest never does", () => {
    const workdirHash = (entries: ConcatEntry[]): string =>
      createHash("sha1").update(folderManifestKey(entries, "name")).digest("hex").slice(0, 8);
    const run1 = [
      entry("05B96FC5-F5FD-4847-B269-C8F2E3473718.MP4", 1785938022000, 114591202),
      entry("52924DE0-8F13-4191-A581-08A747F6DE2A.MP4", 1785938022000, 43730595),
      entry("754D3FF1-FA29-44DB-A31F-678593A1A228.MP4", 1785938022000, 25755631),
      entry("E6820A81-F531-49C5-9D11-84A523D30532.MP4", 1785938850000, 179555444),
    ];
    const run2 = [
      entry("1.MP4", 1785938022000, 25755631),
      entry("2.MP4", 1785938022000, 43730595),
      entry("3.MP4", 1785938022000, 114591202),
      entry("4.MP4", 1785938850000, 179555444),
    ];
    expect(workdirHash(run1)).toBe("1addff5a");
    expect(workdirHash(run2)).toBe("202e2b55");
    // Determinism half: re-statting an untouched folder — same names, sizes,
    // mtimes — keys identically. The field case's stability was verified live
    // (today's stat still keys 202e2b55); this is that invariant, pinned.
    const restat = run2.map((e) => ({ ...e }));
    expect(workdirHash(restat)).toBe(workdirHash(run2));
  });
});

describe("assertAllClipsHaveAudio", () => {
  it("passes silently when every clip has an audio stream", () => {
    expect(() =>
      assertAllClipsHaveAudio([
        { name: "a.mov", hasAudio: true },
        { name: "b.mov", hasAudio: true },
      ]),
    ).not.toThrow();
  });

  // Mocked probe results — a video-only b-roll clip reports hasAudio: false.
  // buildConcatFilter emits [i:a] unconditionally, so without this guard
  // ffmpeg would die on a bare stream-specifier error naming neither file.
  it("throws naming the silent clip, before ffmpeg ever runs", () => {
    expect(() =>
      assertAllClipsHaveAudio([
        { name: "talking-head.mov", hasAudio: true },
        { name: "broll-silent.mp4", hasAudio: false },
      ]),
    ).toThrow(/broll-silent\.mp4/);
  });

  it("names every silent clip when more than one lacks audio", () => {
    expect(() =>
      assertAllClipsHaveAudio([
        { name: "a.mov", hasAudio: false },
        { name: "b.mov", hasAudio: true },
        { name: "c.mov", hasAudio: false },
      ]),
    ).toThrow(/a\.mov.*c\.mov|c\.mov.*a\.mov/s);
  });
});

// 0.1.9 first-contact (2026-08-05): pointed at ~/Downloads (~100 unrelated
// videos), the audio guard spent 4m32s probing everything before refusing 13
// silent b-roll clips. The fix is a fail-fast pool; these are its PURE
// decision half — what the guard concludes from the probe results settled at
// the moment it fires.
describe("evaluateAudioProbes", () => {
  it("returns null while every settled probe has audio", () => {
    expect(
      evaluateAudioProbes(
        [
          { name: "a.mov", hasAudio: true },
          { name: "b.mov", hasAudio: true },
        ],
        5,
      ),
    ).toBeNull();
  });

  it("reports the offenders known so far plus how many clips were never checked", () => {
    expect(
      evaluateAudioProbes(
        [
          { name: "a.mov", hasAudio: true },
          { name: "broll.mp4", hasAudio: false },
        ],
        10,
      ),
    ).toEqual({ offenders: ["broll.mp4"], uncheckedCount: 8 });
  });

  it("reports zero unchecked when every probe settled before the guard fired", () => {
    expect(
      evaluateAudioProbes(
        [
          { name: "a.mov", hasAudio: false },
          { name: "b.mov", hasAudio: true },
        ],
        2,
      ),
    ).toEqual({ offenders: ["a.mov"], uncheckedCount: 0 });
  });
});

describe("audioGuardMessage", () => {
  it("keeps the thorough complete-list text when everything was checked", () => {
    const msg = audioGuardMessage({ offenders: ["a.mov", "c.mov"], uncheckedCount: 0 });
    expect(msg).toMatch(/no audio stream in: a\.mov, c\.mov/);
    expect(msg).toMatch(/produce cuts by silence/);
    expect(msg).not.toMatch(/not checked/);
  });

  it("is honest about aborting early when clips remain unchecked", () => {
    const msg = audioGuardMessage({ offenders: ["broll.mp4"], uncheckedCount: 87 });
    expect(msg).toMatch(/no audio stream in: broll\.mp4/);
    // "Result", not "clip", and no "later" (review, Minor 1): probes settle in
    // parallel, so the unchecked set can include clips EARLIER in concat order
    // than the offender — the wording must not claim an ordering.
    expect(msg).toMatch(/stopped at the first missing-audio result/i);
    expect(msg).toMatch(/87 clips were not checked/);
    expect(msg).not.toMatch(/later/);
  });

  it("suggests the likely real mistake: a mixed folder like ~\\/Downloads", () => {
    // The field report's actual error was upstream of the guard — the wizard
    // was answered with all of ~/Downloads instead of a clips folder. The
    // message must point at that, in both the complete and the aborted shape.
    expect(audioGuardMessage({ offenders: ["a.mov"], uncheckedCount: 0 })).toMatch(/~\/Downloads/);
    expect(audioGuardMessage({ offenders: ["a.mov"], uncheckedCount: 3 })).toMatch(/~\/Downloads/);
  });
});

describe("probeClipsWithAudioGuard", () => {
  it("returns every result in input order when all clips have audio", async () => {
    const results = await probeClipsWithAudioGuard(
      ["a.mov", "b.mov", "c.mov"],
      async (name) => ({ hasAudio: true, name }),
      2,
    );
    expect(results.map((r) => r.name)).toEqual(["a.mov", "b.mov", "c.mov"]);
  });

  it("rejects at the FIRST missing-audio result without waiting on slower probes", async () => {
    // c's probe never settles — pre-fix, the guard awaited ALL probes
    // (Promise.all) before deciding, which is exactly the 4m32s.
    const p = probeClipsWithAudioGuard(
      ["a.mov", "b.mov", "c.mov"],
      (name) => {
        if (name === "c.mov") return new Promise<{ hasAudio: boolean }>(() => {});
        return Promise.resolve({ hasAudio: name !== "b.mov" });
      },
      3,
    );
    await expect(p).rejects.toThrow(/no audio stream in: b\.mov/);
    await expect(p).rejects.toThrow(/1 clip was not checked/);
  });

  it("stops launching new probes once the guard has fired", async () => {
    const launched: string[] = [];
    await expect(
      probeClipsWithAudioGuard(
        ["silent.mp4", "b.mov", "c.mov"],
        (name) => {
          launched.push(name);
          return Promise.resolve({ hasAudio: false });
        },
        1,
      ),
    ).rejects.toThrow(/silent\.mp4/);
    expect(launched).toEqual(["silent.mp4"]);
  });

  it("never holds more probes in flight than the pool bound", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await probeClipsWithAudioGuard(
      ["a", "b", "c", "d", "e", "f"],
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { hasAudio: true };
      },
      2,
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("propagates a probe failure (e.g. `no video stream in <path>`) as-is", async () => {
    await expect(
      probeClipsWithAudioGuard(
        ["a.mov"],
        () => Promise.reject(new Error("no video stream in a.mov")),
        4,
      ),
    ).rejects.toThrow(/no video stream in a\.mov/);
  });

  it("rejects instead of deadlocking when probeOne throws synchronously", async () => {
    // Review, Minor 2: with concurrency 1, b's probe is a replacement launch
    // fired from inside a's success handler — a SYNC throw there used to
    // escape both promise handlers, leaving the pool one settle short of ever
    // resolving. Unreachable with the real async probe; the generic API must
    // not depend on that.
    await expect(
      probeClipsWithAudioGuard(
        ["a.mov", "b.mov"],
        (name) => {
          if (name === "b.mov") throw new Error("sync throw from b.mov");
          return Promise.resolve({ hasAudio: true });
        },
        1,
      ),
    ).rejects.toThrow(/sync throw from b\.mov/);
  });
});
