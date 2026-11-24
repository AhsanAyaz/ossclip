import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ThemeSchema, checkDrawnScene, lookTheme, stageBundledFonts } from "@ossclip/core";
import { DRAW_KIT_EXPORTS } from "@ossclip/scenes/draw/reference";
import { isBlankRgba } from "../src/drawn/blank";
import type { DrawnRenderProps } from "../src/drawn/entry-source";
import { bundleDrawnScene, renderDrawnClip, renderDrawnPreview, renderDrawnStills } from "../src/drawn/render";

/**
 * Drawn scenes through a real bundle and a real headless browser (§167). The
 * first tests in this repo that start one: ci.yml never renders (see the
 * render-e2e.yml header), so these run only where Remotion's browser has
 * already been downloaded, and ffmpeg is there to read the files back. On a
 * fresh clone, one `pnpm ossclip` render (or `pnpm stills`) fetches it.
 *
 * Every scene is copied into a temp WORKDIR before it is bundled, because
 * that is where real scenes live: outside this repo, with no node_modules
 * beside them. The resolve rule and the kit alias are only proven from there.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "drawn");
const REPO = resolve(HERE, "..", "..", "..");

// Where Remotion keeps the browser it downloads (getDownloadsCacheDir in
// @remotion/renderer 4.0.499: `node_modules/.remotion` beside the nearest
// package.json, which is the repo root for a vitest run).
const hasBrowser = existsSync(join(REPO, "node_modules", ".remotion", "chrome-headless-shell"));
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const WIDTH = 1080;
const HEIGHT = 1920;

/** A PNG's pixels as RGBA bytes, through ffmpeg (no PNG decoder in this workspace). */
function rgba(png: string): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function pixel(px: Buffer, x: number, y: number): [number, number, number, number] {
  const i = (y * WIDTH + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
}

function probe(file: string): Record<string, string> {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
      "stream=codec_name,profile,pix_fmt,width,height,nb_read_frames", "-of", "default=noprint_wrappers=1", file],
    { encoding: "utf8" },
  );
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=") as [string, string]));
}

describe.skipIf(!hasBrowser || !hasFfmpeg)("drawn scenes in the browser (§167)", () => {
  let work: string;
  let publicDir: string;
  const serveUrls: string[] = [];
  // The explainer look, so the theme's fonts are "bundled" and the host
  // really fetches font files through the policy.
  const theme = ThemeSchema.parse({ ...lookTheme("explainer") });
  const props: DrawnRenderProps = {
    durationSec: 3,
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    theme,
    assets: { dot: "storyboard-assets/dot.png" },
  };

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "ossclip-drawn-"));
    publicDir = join(work, "render-public");
    // The caller's half of bundleDrawnScene's contract, as `pnpm stills`
    // does it: fonts staged into the public dir before the bundle, and the
    // asset under the path `props.assets` names.
    stageBundledFonts(theme, [publicDir]);
    mkdirSync(join(publicDir, "storyboard-assets"), { recursive: true });
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=0x00ff00:s=64x64", "-frames:v", "1",
      "-y", join(publicDir, "storyboard-assets", "dot.png"),
    ]);
  });

  afterAll(() => {
    for (const u of serveUrls) rmSync(u, { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** The fixture copied into the workdir (with `__PROBE__` replaced), bundled. */
  async function bundled(name: string, probeOrigin?: string): Promise<string> {
    const code = readFileSync(join(FIXTURES, `${name}.tsx`), "utf8");
    const scenePath = join(work, "storyboard", "shot", `${name}.tsx`);
    mkdirSync(dirname(scenePath), { recursive: true });
    writeFileSync(scenePath, probeOrigin ? code.replaceAll("__PROBE__", probeOrigin) : code);
    const serveUrl = await bundleDrawnScene({ scenePath, workDir: work, publicDir });
    serveUrls.push(serveUrl);
    return serveUrl;
  }

  let circleUrl: Promise<string> | undefined;
  const circle = () => (circleUrl ??= bundled("circle"));

  it("(a) a kit scene gives three non-blank PNGs with a transparent corner, under the policy", async () => {
    // The honest case: this fixture is a scene the static check passes.
    expect(checkDrawnScene(readFileSync(join(FIXTURES, "circle.tsx"), "utf8"), DRAW_KIT_EXPORTS)).toEqual([]);
    const serveUrl = await circle();
    const logs: string[] = [];
    const stills = await renderDrawnStills({
      serveUrl,
      props,
      outDir: join(work, "stills-a"),
      timeoutMs: 30_000,
      onBrowserLog: (l) => logs.push(`${l.type}: ${l.text}`),
    });
    expect(stills.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual(["still-1.png", "still-2.png", "still-3.png"]);
    for (const still of stills) {
      const px = rgba(still);
      expect(px.length).toBe(WIDTH * HEIGHT * 4);
      expect(isBlankRgba(px)).toBe(false);
      expect(pixel(px, 0, 0)[3], `${still} corner`).toBe(0);
      // The circle sits on the safe area's centre with a quarter of its
      // width as radius: the frame's centre is inside it. Drawn there only
      // if useTheme() and useSafeArea() found the host's provider, i.e. the
      // scene and the host share one kit module.
      expect(pixel(px, WIDTH / 2, HEIGHT / 2)[3], `${still} centre`).toBe(255);
    }
    // The bundle's own scripts ran (the stills exist), the asset loaded
    // (Remotion's <Img> cancels the render when it cannot), and the fonts
    // were fetched without a refusal or a 404: nothing the page itself needs
    // was blocked by the policy.
    expect(logs.filter((l) => /Content Security Policy|Failed to load resource/i.test(l))).toEqual([]);
  }, 120_000);

  it("(b) a scene that throws while rendering rejects, with its message", async () => {
    const serveUrl = await bundled("throws");
    await expect(
      renderDrawnStills({ serveUrl, props, outDir: join(work, "stills-b"), timeoutMs: 30_000 }),
    ).rejects.toThrow(/exploded on purpose/);
    expect(existsSync(join(work, "stills-b", "still-1.png"))).toBe(false);
  }, 120_000);

  it("(c) a scene whose render never returns rejects at its time limit (Review Focus 2)", async () => {
    const serveUrl = await bundled("loop");
    // performance.now(), not Date.now(): WSL's wall clock was seen to step
    // while this ran (a 15 s timer measured 13.6 s), the monotonic one not.
    const t0 = performance.now();
    await expect(
      renderDrawnStills({ serveUrl, props, outDir: join(work, "stills-c"), timeoutMs: 15_000 }),
    ).rejects.toThrow(/did not finish within 15000 ms/);
    const elapsed = performance.now() - t0;
    // The limit is per browser step, so the browser's start and the
    // composition's selection come before the stuck still's clock starts
    // (0.4 s measured). Without this function's own timer, Remotion's alone
    // rejected at 27.7 s.
    expect(elapsed).toBeGreaterThanOrEqual(15_000);
    expect(elapsed).toBeLessThan(15_000 + 5_000);
  }, 120_000);

  describe("(d) the policy keeps the page off the network", () => {
    let server: Server;
    const hits: string[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("x");
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    });

    afterAll(async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
    });

    it("fetch, <img>, new Image() and CSS url() to another origin reach the probe 0 times; data: still paints", async () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const serveUrl = await bundled("network", origin);
      const logs: string[] = [];
      const stills = await renderDrawnStills({
        serveUrl,
        props,
        outDir: join(work, "stills-d"),
        timeoutMs: 30_000,
        onBrowserLog: (l) => logs.push(l.text),
      });
      // A late request would still have to arrive; give it the time to.
      await new Promise((ok) => setTimeout(ok, 500));
      expect(hits).toEqual([]);
      // Positive control: it was the policy that refused them, not a scene
      // that failed to ask.
      expect(logs.some((l) => l.includes("Content Security Policy"))).toBe(true);
      const [r, g, b, a] = pixel(rgba(stills[0]!), 100, 100);
      expect({ r, g, b, a }).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    }, 120_000);
  });

  it("the preview is a VP8 WebM at a quarter of the frame, over grey", async () => {
    const serveUrl = await circle();
    const outPath = join(work, "preview.webm");
    await renderDrawnPreview({ serveUrl, props, outPath });
    expect(probe(outPath)).toMatchObject({ codec_name: "vp8", width: "270", height: "480", nb_read_frames: "90" });
    expect(existsSync(join(work, "preview.partial.webm"))).toBe(false);
    // Grey, not transparent-as-black: the first frame's corner pixel. The
    // whole frame is decoded, as a 1x1 crop of yuv420p is refused by ffmpeg
    // (the chroma plane would be 0 wide).
    const frame = execFileSync("ffmpeg", ["-v", "error", "-i", outPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    expect(frame.length).toBe(270 * 480 * 3);
    for (const c of frame.subarray(0, 3)) expect(Math.abs(c - 0x80)).toBeLessThan(12);
  }, 180_000);

  it("the clip is ProRes 4444 with alpha, written under its name only when done", async () => {
    const serveUrl = await circle();
    const outPath = join(work, "approved.mov");
    await renderDrawnClip({ serveUrl, props, outPath });
    // ffprobe names the DECODER's format (ffmpeg's prores decoder gives
    // yuva444p12le for the yuva444p10le Remotion encodes); what matters is
    // the "a", and the decoded frame below shows the alpha is real.
    const info = probe(outPath);
    expect(info).toMatchObject({ codec_name: "prores", profile: "4444", nb_read_frames: "90" });
    expect(info.pix_fmt).toMatch(/^yuva444p/);
    expect(existsSync(join(work, "approved.partial.mov"))).toBe(false);
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", outPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(pixel(px, 0, 0)[3]).toBe(0);
    expect(pixel(px, WIDTH / 2, HEIGHT / 2)[3]).toBe(255);
  }, 300_000);
});
