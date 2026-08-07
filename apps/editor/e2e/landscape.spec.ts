import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PROPS = join(WORKDIR, "render-props.json");

/**
 * The 16:9 half of R15 (§55/§56/§57). Runs in its OWN Playwright project,
 * serialized after `main`: it rewrites the shared workdir's render-props.json
 * to a landscape frame (the edit server reads the file per request, so one
 * server serves both shapes) and restores it when done.
 */

let portraitProps = "";

test.beforeAll(async () => {
  portraitProps = await readFile(PROPS, "utf8");
  const props = JSON.parse(portraitProps);
  props.settings = { ...props.settings, width: 1920, height: 1080 };
  await writeFile(PROPS, JSON.stringify(props));
});

test.afterAll(async () => {
  if (portraitProps) await writeFile(PROPS, portraitProps);
});

test("the preview fills the stage area in landscape too (§55a)", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  const stage = (await page.getByTestId("stage").boundingBox())!;
  // 1280px window minus the 260px sidebar and padding leaves ~950px; the old
  // fixed width rendered 380px regardless. Sized from the container, a 16:9
  // preview should claim most of it.
  expect(stage.width).toBeGreaterThan(650);
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 1);
});

test("caption retype works in landscape, at the SMALL preview that broke it (§57)", async ({
  page,
}) => {
  // The §57 mechanism, reproduced deliberately: shrink the window until the
  // preview is about as short as the old fixed-width landscape preview
  // (≈214px), which parks the caption band inside the Player's transport
  // strip — the strip keeps pointer events while faded, so the old bare
  // elementFromPoint hit the transport and the retype never opened. The fix
  // resolves the double-click through the same drill-down walk every other
  // stage hit-test uses.
  await page.setViewportSize({ width: 640, height: 560 });
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  const stage = (await page.getByTestId("stage").boundingBox())!;
  expect(stage.height, "preview must be short enough to reproduce the overlap").toBeLessThan(230);

  // Park the playhead on a plain TAKE — full-bleed staging, whose caption
  // anchor (0.7) is the one that lands in the strip on a short preview.
  // Ruler seek + click: a block click only selects now (field report
  // 2026-08-07), it no longer parks the playhead by itself.
  const takeBlock = page.locator('[data-testid^="timeline-block-take-"]').first();
  const tb = (await takeBlock.boundingBox())!;
  const rulerBox = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(tb.x + tb.width * 0.65, rulerBox.y + rulerBox.height / 2);
  // Click OFF the just-parked playhead — its grab zone intercepts a click at
  // the same x it was parked at.
  await takeBlock.click({ position: { x: tb.width * 0.3, y: tb.height / 2 } });
  const word = page.locator("[data-caption-word]").first();
  await expect(word).toBeVisible();
  const box = (await word.boundingBox())!;
  // The repro's precondition, asserted so this test can't silently stop
  // covering it: the caption sits inside the bottom 64px transport strip.
  expect(box.y + box.height / 2).toBeGreaterThan(stage.y + stage.height - 64);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("caption-edit")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("caption position override moves the words in landscape (§56)", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  // Ruler seek + click — the block click only selects now (field report
  // 2026-08-07), and this test needs scene-0's captions on stage.
  const sceneBlock = page.getByTestId("timeline-block-scene-0");
  const sb = (await sceneBlock.boundingBox())!;
  const rb = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(sb.x + sb.width * 0.65, rb.y + rb.height / 2);
  // Click OFF the just-parked playhead — its grab zone intercepts a click at
  // the same x it was parked at.
  await sceneBlock.click({ position: { x: sb.width * 0.3, y: sb.height / 2 } });
  const word = page.locator("[data-caption-word]").first();
  await expect(word).toBeVisible();
  const before = (await word.boundingBox())!.y;

  const slider = page.getByTestId("caption-y-slider");
  await slider.focus();
  await page.keyboard.press("Home"); // anchor 0.05 — the top of the range
  await expect
    .poll(async () => (await word.boundingBox())!.y)
    .toBeLessThan(before - 40);
  // Not saved — reloading elsewhere discards the in-memory override.
});
