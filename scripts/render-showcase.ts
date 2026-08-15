import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = join(ROOT, "docs", "local");
const OUT_VIDEO = join(OUT_DIR, "gemini-3.7-flash-showcase.mp4");
const OUT_COVER = join(OUT_DIR, "gemini-3.7-flash-showcase.cover.jpg");

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("▸ Bundling Remotion showcase composition…");
  const serveUrl = await bundle({
    entryPoint: join(HERE, "showcase-comp.tsx"),
  });

  console.log("▸ Selecting composition 'Showcase' (1080x1080 @ 30fps)…");
  const composition = await selectComposition({
    serveUrl,
    id: "Showcase",
  });

  console.log(`▸ Rendering master video to ${OUT_VIDEO}…`);
  const start = Date.now();
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: OUT_VIDEO,
    concurrency: 4,
    onProgress: ({ progress }) => {
      const pct = Math.round(progress * 100);
      process.stdout.write(`\r  [${"█".repeat(Math.floor(pct / 5))}${"░".repeat(20 - Math.floor(pct / 5))}] ${pct}% rendered`);
    },
  });
  console.log(`\n✓ Video rendered in ${((Date.now() - start) / 1000).toFixed(1)}s → ${OUT_VIDEO}`);

  console.log("▸ Rendering showcase still/cover frame…");
  await renderStill({
    composition,
    serveUrl,
    outputLocation: OUT_COVER,
    frame: 280,
  });
  console.log(`✓ Cover rendered → ${OUT_COVER}`);
}

main().catch((err) => {
  console.error("Render failed:", err);
  process.exit(1);
});
