import { createReadStream } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Warm the OS page cache with the video the editor is about to play
 * (2026-11-13 field report: first playback stutters and jerks, a replay is
 * smooth).
 *
 * The Player mounts one `<video>` per kept span, and each one seeks into the
 * mezzanine on its own. On a slow filesystem — the measured case was a
 * project on a Windows drive under WSL (`/mnt/c`, drvfs) — those cold random
 * reads cannot keep up with playback: a fresh browser on a cold file logged 4
 * `waiting` stalls and 71 frame gaps over 80ms in 25s of play; the same fresh
 * browser on the same file once the page cache held it logged ZERO stalls.
 * One sequential read when the project opens is the cheap way to get the
 * second number on the first play.
 *
 * Best-effort by design: any failure (missing file, permission, abort) just
 * resolves — playback works without the warm-up, it is only slower.
 */
export function warmFileCache(
  path: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; complete: boolean }> {
  return new Promise((resolveP) => {
    let bytes = 0;
    let settled = false;
    const done = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      resolveP({ bytes, complete });
    };
    if (signal?.aborted) return done(false);
    // Big chunks: the point is a sequential sweep the filesystem can stream,
    // not many small reads.
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    const onAbort = (): void => {
      stream.destroy();
      done(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
    });
    stream.on("end", () => {
      signal?.removeEventListener("abort", onAbort);
      done(true);
    });
    stream.on("error", () => {
      signal?.removeEventListener("abort", onAbort);
      done(false);
    });
  });
}

const PropsVideo = z.object({ videoFileName: z.string().min(1) });

/**
 * The file to warm for a workdir's render-props, or null. Parsed, not read
 * off an `any`, and confined to the workdir like `/media/` is — the name
 * comes from a file the user can edit.
 */
export function warmTargetFor(workdir: string, renderProps: unknown): string | null {
  const parsed = PropsVideo.safeParse(renderProps);
  if (!parsed.success) return null;
  const file = join(workdir, parsed.data.videoFileName);
  const rel = relative(workdir, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return file;
}
