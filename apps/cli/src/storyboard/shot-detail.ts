/**
 * What the editor's shot view is served of one drawn shot (storyboard
 * design §10 "Shot view"; plan B2a Task 4; §169): its versions with their
 * stills and preview as `/media/` URLs, the draft, the notes, and the idea
 * the draft was drawn from.
 *
 * URLs, never paths, and only of files that exist: the page shows them as
 * `<img>` and `<video>` (Global Constraints: LLM-written code never reaches
 * the editor page, so stills and previews are all it sees of a shot), and
 * a URL to a file that is not there is a broken image the author would
 * read as a broken drawing.
 */
import { existsSync, readdirSync } from "node:fs";
import { relative, sep } from "node:path";
import { versionIdea } from "@ossclip/core";
import { peekShot, versionPaths } from "../draw/shot-store";

export interface ShotDetail {
  versions: {
    n: number;
    ok: boolean;
    error?: string;
    said?: string;
    kitVersion: number;
    /** "/media/storyboard/<id>/v<n>/still-1.png" …, only files that exist. */
    stills: string[];
    /** "/media/storyboard/<id>/v<n>/preview.webm" when it exists. */
    preview: string | null;
  }[];
  draft: number | null;
  notes: { onVersion: number; text: string }[];
  /** The idea the draft was drawn from (§169: its own, else the history's); null with no draft. */
  drawnIdea: string | null;
}

const STILL_NAME = /^still-(\d+)\.png$/;

/**
 * The shot's detail, or null when it has no history (never drawn).
 *
 * Read through `peekShot`: a draw of this shot may be running, and its
 * version without a result is work in progress, not debris, so it is left
 * out of the answer but not deleted (the `GET /api/storyboard` rule, §168).
 * Throws, naming the file, for a history that does not parse.
 */
export function shotDetail(workdir: string, id: string): ShotDetail | null {
  const h = peekShot(workdir, id);
  if (h === null) return null;
  const url = (abs: string): string => `/media/${relative(workdir, abs).split(sep).join("/")}`;
  return {
    versions: h.versions.map((v) => {
      const paths = versionPaths(workdir, id, v.n);
      const ok = v.result === "ok";
      // A failed version shows no stills even when some are on disk: they
      // may be an earlier attempt's drawing, beside code that is not
      // (runDraw removes them for this reason; a hand-made folder may not).
      const stills =
        ok && existsSync(paths.stillsDir)
          ? readdirSync(paths.stillsDir)
              .flatMap((name) => {
                const m = STILL_NAME.exec(name);
                return m ? [{ k: Number(m[1]), name }] : [];
              })
              .sort((a, b) => a.k - b.k)
              .map((s) => `${url(paths.stillsDir)}/${s.name}`)
          : [];
      return {
        n: v.n,
        ok,
        ...(typeof v.result === "object" ? { error: v.result.failed } : {}),
        ...(v.said !== undefined ? { said: v.said } : {}),
        kitVersion: v.kitVersion,
        stills,
        preview: ok && existsSync(paths.preview) ? url(paths.preview) : null,
      };
    }),
    draft: h.draft,
    notes: h.notes.map((n) => ({ onVersion: n.onVersion, text: n.text })),
    drawnIdea: h.draft === null ? null : versionIdea(h, h.draft),
  };
}
