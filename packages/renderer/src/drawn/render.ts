/**
 * The I/O half of drawn scenes (§167, storyboard design §5 "New renderer
 * pieces"): one bundle per scene version, its three stills, the quarter-size
 * preview and the transparent clip. The decisions live in the pure files
 * beside this one (entry-source.ts, csp.ts, preview-options.ts) and in
 * render-options.ts's `clipRenderOptions`.
 *
 * A drawn scene is LLM-written code. It runs ONLY in the headless browser
 * Remotion starts (plan Global Constraints): nothing here imports or
 * evaluates the scene file in Node. Webpack reads it as text and bundles it
 * for the page, and the page is served with `DRAW_CSP`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type CancelSignal,
} from "@remotion/renderer";
import { clipRenderOptions } from "../render-options";
import { partialClipPath } from "../scene-clip";
import { injectCsp } from "./csp";
import { DRAWN_COMPOSITION_ID, drawnEntrySource, drawnStillFrames, type DrawnRenderProps } from "./entry-source";
import { drawnPreviewOptions, drawnPreviewProps } from "./preview-options";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The host every generated entry imports, by absolute path from this package's source. */
export const DRAWN_HOST_PATH = join(HERE, "DrawnSceneHost.tsx");

/**
 * The renderer package's own `node_modules`. A workdir has none, so a scene's
 * imports cannot resolve from beside it; the spike's rule (plan "Spike
 * results") looks here first, then in the usual hierarchical `node_modules`.
 * `react`, `react-dom` and `remotion` are aliased to absolute paths by
 * Remotion's own bundler config, so this rule matters for anything else a
 * scene or the kit pulls in.
 */
const RENDERER_NODE_MODULES = join(HERE, "..", "..", "node_modules");

/**
 * The webpack change a drawn bundle needs, over Remotion's config.
 *
 * The alias is EXACT (`$`): only the specifier `@ossclip/scenes/draw` itself,
 * the one module the static check lets a scene import. It points at the
 * kit's resolved source file, and it applies to every importer, the scene AND
 * DrawnSceneHost, so both get one module instance and one React context
 * (§167). Without that shared instance the scene's `useTheme()` throws
 * "outside <DrawProvider>" under a host that mounted one.
 */
function drawnWebpackOverride(kitEntry: string): WebpackOverrideFn {
  return (config) => {
    const alias = config.resolve?.alias ?? {};
    if (Array.isArray(alias)) {
      // Remotion 4.0.499 writes an object; an array form would need merging
      // by entry, and guessing at it could silently drop Remotion's own
      // react/remotion aliases, which is two Reacts on the page.
      throw new Error("drawn-scene bundle: Remotion's webpack alias is an array; expected an object");
    }
    return {
      ...config,
      resolve: {
        ...config.resolve,
        modules: [RENDERER_NODE_MODULES, "node_modules"],
        alias: { ...alias, "@ossclip/scenes/draw$": kitEntry },
      },
    };
  };
}

/**
 * Bundles ONE drawn scene file and returns the serve URL (a directory).
 *
 * One bundle per scene version, never per batch (plan "Spike results": 2.4 s
 * a bundle, 1.0 s a still): one bad scene must not take another down with it,
 * and a version's stills, preview and clip all render from its one bundle.
 *
 * The generated entry is written to `<workDir>/.draw-entry/<hash>.tsx`, named
 * by a hash of the scene's absolute path so two versions never share an entry
 * and a rebuild of the same version overwrites its own.
 *
 * CALLER CONTRACT for `publicDir`: it is copied whole into the bundle and
 * served as the page's own origin, so it must be a small directory made for
 * the render, never the workdir itself (the source video would be copied on
 * every bundle). The caller stages into it, BEFORE calling this:
 * - the theme's bundled fonts: `stageBundledFonts(theme, [publicDir])` from
 *   `@ossclip/core`. `<BundledFonts>` in the host fetches them with
 *   `staticFile`; unstaged, they 404 and the stills bake in the fallback stack.
 * - the author's assets, under the paths `DrawnRenderProps.assets` names.
 *
 * The bundle's index.html is then rewritten with the content security policy
 * (`injectCsp`, which throws rather than leave a page unguarded).
 */
export async function bundleDrawnScene(a: { scenePath: string; workDir: string; publicDir: string }): Promise<string> {
  const scenePath = resolve(a.scenePath);
  const entryDir = join(a.workDir, ".draw-entry");
  await mkdir(entryDir, { recursive: true });
  const entryPoint = join(entryDir, `${createHash("sha256").update(scenePath).digest("hex").slice(0, 16)}.tsx`);
  await writeFile(entryPoint, drawnEntrySource({ scenePath, hostPath: DRAWN_HOST_PATH }));
  const kitEntry = createRequire(import.meta.url).resolve("@ossclip/scenes/draw");
  const serveUrl = await bundle({
    entryPoint,
    publicDir: a.publicDir,
    webpackOverride: drawnWebpackOverride(kitEntry),
  });
  const indexPath = join(serveUrl, "index.html");
  await writeFile(indexPath, injectCsp(await readFile(indexPath, "utf8")));
  return serveUrl;
}

/** A console line from the render page, for a caller that wants the scene's errors or policy reports. */
export type DrawnBrowserLog = (log: { type: string; text: string }) => void;

/**
 * Renders the three stills (`drawnStillFrames`) as PNG with alpha, into
 * `<outDir>/still-1.png` … `still-3.png` (design §9's names), and returns
 * their paths in that order.
 *
 * Rejects when the scene throws while rendering (DrawnSceneHost's boundary
 * cancels the render) and when a step runs past `timeoutMs`. The time limit
 * is per browser step (selecting the composition, each still), so it reads
 * as "one still may take this long" (design §5 step 3).
 *
 * The time limit is this function's own timer, not Remotion's alone.
 * Measured 2026-11-20 with a `while (true) {}` scene and
 * `timeoutInMilliseconds: 15000`: Remotion rejected only after 27.7 s
 * ("timeout 18000ms exceeded"). Its page wait runs at the limit plus 3 s, so
 * that the page's own delayRender timeout can fire first, and then spends up
 * to 5 s more asking the page for its open handles. A page whose one thread
 * is stuck in the scene answers neither. So the browser is opened here and
 * handed to every step (`puppeteerInstance`); when a step's timer fires, the
 * browser is closed, which SIGKILLs its whole process group (Remotion's
 * BrowserRunner), and the step rejects at the limit. Remotion's option is
 * still passed: for a page that is alive but held (a delayRender never
 * released) its message names the open handles, a better repair hint.
 */
export async function renderDrawnStills(a: {
  serveUrl: string;
  props: DrawnRenderProps;
  outDir: string;
  timeoutMs: number;
  browserExecutable?: string;
  onBrowserLog?: DrawnBrowserLog;
}): Promise<string[]> {
  await mkdir(a.outDir, { recursive: true });
  const inputProps = a.props as unknown as Record<string, unknown>;
  const browser = await openBrowser("chrome", { browserExecutable: a.browserExecutable ?? null });
  const common = {
    serveUrl: a.serveUrl,
    inputProps,
    browserExecutable: a.browserExecutable,
    puppeteerInstance: browser,
    timeoutInMilliseconds: a.timeoutMs,
    onBrowserLog: a.onBrowserLog,
  };
  const step = <T>(what: string, run: Promise<T>): Promise<T> =>
    withinTimeLimit(run, a.timeoutMs, what, () => browser.close({ silent: true }));
  try {
    const composition = await step(
      "selecting the composition",
      selectComposition({ ...common, id: DRAWN_COMPOSITION_ID }),
    );
    const paths: string[] = [];
    for (const [i, frame] of drawnStillFrames(a.props.durationSec, a.props.fps).entries()) {
      const output = join(a.outDir, `still-${i + 1}.png`);
      await step(
        `the still at frame ${frame}`,
        renderStill({ ...common, composition, output, frame, imageFormat: "png", overwrite: true }),
      );
      paths.push(output);
    }
    return paths;
  } finally {
    // Every path, not only the timeout's: a browser handed in as
    // `puppeteerInstance` is the caller's to close, and Remotion leaves it.
    await pagesClosed(browser);
    await browser.close({ silent: true });
  }
}

/** How long a failed still's page is given to finish closing before the browser goes. */
const PAGE_CLOSE_GRACE_MS = 3000;

/**
 * Waits until the browser has no page left, at most `PAGE_CLOSE_GRACE_MS`.
 *
 * Why (§168): when a scene throws, Remotion's still renderer rejects and, in
 * the same tick, starts closing its page without awaiting or catching it
 * (`cleanup()` in its render-still.js sends `Target.closeTarget`). Closing the
 * browser while that is in flight makes the send reject with "Target closed"
 * inside Remotion, where nothing can catch it: an unhandled rejection in the
 * CLI process. It showed only when the machine was busy (the whole test suite
 * with six produce runs beside it). Letting the page finish closing first
 * removes the race. After a timeout the browser is already closed and there
 * is nothing to wait for; a page that never closes is cut off at the grace.
 */
async function pagesClosed(browser: Awaited<ReturnType<typeof openBrowser>>): Promise<void> {
  const openPages = (): number => {
    try {
      return browser.targets().filter((t) => t.type() === "page").length;
    } catch {
      return 0; // a browser that is already gone has no pages to wait for
    }
  };
  const deadline = performance.now() + PAGE_CLOSE_GRACE_MS;
  while (openPages() > 0 && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * `run`, or a rejection at `ms`, at which point `expire()` starts tearing
 * down what `run` is waiting on (the caller still awaits the teardown before
 * it returns). Once the limit has passed, the limit IS the error: `run` then
 * rejects too, with the closed browser's "Target closed", and that message
 * would hide why the browser was closed.
 */
async function withinTimeLimit<T>(run: Promise<T>, ms: number, what: string, expire: () => Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: Error | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = new Error(
        `drawn scene: ${what} did not finish within ${ms} ms; a scene that never returns from rendering (an endless loop) looks like this`,
      );
      reject(timedOut);
      expire().catch(() => {});
    }, ms);
  });
  try {
    return await Promise.race([run, expired]);
  } catch (err) {
    throw timedOut ?? err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders the preview (design §7): VP8 WebM at a quarter of the frame, over
 * mid-grey (`drawnPreviewOptions`). Written to the partial name and renamed
 * on success, as the clip is, so the editor never plays a truncated file
 * under the preview's own name.
 */
export async function renderDrawnPreview(a: {
  serveUrl: string;
  props: DrawnRenderProps;
  outPath: string;
  browserExecutable?: string;
}): Promise<void> {
  const inputProps = drawnPreviewProps(a.props);
  const composition = await selectComposition({
    serveUrl: a.serveUrl,
    id: DRAWN_COMPOSITION_ID,
    inputProps,
    browserExecutable: a.browserExecutable,
  });
  const partial = partialClipPath(a.outPath);
  try {
    await renderMedia(
      drawnPreviewOptions({
        composition,
        serveUrl: a.serveUrl,
        inputProps,
        outPath: partial,
        browserExecutable: a.browserExecutable,
      }),
    );
    await rename(partial, a.outPath);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

/**
 * Renders the approved clip (design §8): ProRes 4444 with alpha, PNG frames,
 * through `clipRenderOptions` unchanged, so a drawn clip is the same format
 * as a kit clip and a hand-made one. `renderSceneClip`'s partial-file rename:
 * a clip that fails or is cancelled never exists under its final name.
 */
export async function renderDrawnClip(a: {
  serveUrl: string;
  props: DrawnRenderProps;
  outPath: string;
  browserExecutable?: string;
  cancelSignal?: CancelSignal;
}): Promise<void> {
  const inputProps = a.props as unknown as Record<string, unknown>;
  const composition = await selectComposition({
    serveUrl: a.serveUrl,
    id: DRAWN_COMPOSITION_ID,
    inputProps,
    browserExecutable: a.browserExecutable,
  });
  const partial = partialClipPath(a.outPath);
  try {
    await renderMedia(
      clipRenderOptions({
        composition,
        serveUrl: a.serveUrl,
        inputProps,
        opts: { outPath: partial, browserExecutable: a.browserExecutable, cancelSignal: a.cancelSignal },
      }),
    );
    await rename(partial, a.outPath);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}
