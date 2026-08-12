import { test, expect, type Page } from "@playwright/test";

/**
 * The project picker's two lists are scroll regions (R17 §83). §138 is the bug
 * this file exists for: the rows are flex items with `overflow: hidden`, which
 * gives them an automatic minimum size of ZERO — so instead of the list
 * overflowing and scrolling, every row shrank to a few pixels and the glyphs
 * overlapped. The list never overflowed, so `overflow-y: auto` never engaged.
 *
 * Both lists are seeded past their height here on purpose: a picker with three
 * recents and a short folder cannot reproduce it, which is why it survived
 * weeks of a green suite.
 */

// Near-identical long prefixes, exactly like the paths a real user
// accumulates — the tail is the only distinguishing part, which is what the
// row's head-truncation is for.
const RECENTS = Array.from(
  { length: 9 },
  (_, i) => `/Users/someone/work/clients/acme-media/season-two/episode-${String(i + 1).padStart(2, "0")}/.ossclip/render`,
);

const FS_ENTRIES = Array.from({ length: 18 }, (_, i) => ({
  name: `folder-${String(i + 1).padStart(2, "0")}`,
  path: `/Users/someone/work/folder-${String(i + 1).padStart(2, "0")}`,
  isWorkdir: i % 5 === 0,
}));

/** Seeds both lists past their container heights, then opens the picker. */
const openSeededPicker = async (page: Page): Promise<void> => {
  await page.route("**/api/production", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, recent: RECENTS } });
  });
  await page.route("**/api/fs*", async (route) =>
    route.fulfill({
      json: {
        dir: "/Users/someone/work",
        parent: "/Users/someone",
        isWorkdir: false,
        entries: FS_ENTRIES,
      },
    }),
  );
  await page.goto("/");
  await page.getByTestId("open-button").click();
  await expect(page.getByTestId("project-picker")).toBeVisible();
  // The fs list renders on the /api/fs response, not on the picker mounting.
  await expect(page.getByTestId("project-fs-dir").first()).toBeVisible();
};

/** clientHeight/scrollHeight of a list, read from the live layout. */
const metrics = async (page: Page, testId: string): Promise<{ client: number; scroll: number }> =>
  page.getByTestId(testId).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));

test.describe("project picker layout", () => {
  test("rows keep a real height and the lists scroll instead of squashing", async ({ page }) => {
    await openSeededPicker(page);

    // A row is one line of 13px monospace plus 5px padding each side plus the
    // 1px border: ~28px. Anything under 24 is the squash, not a tight row.
    for (const testId of ["project-recent", "project-fs-dir"]) {
      const rows = page.getByTestId(testId);
      const count = await rows.count();
      expect(count).toBeGreaterThan(3);
      for (let i = 0; i < count; i++) {
        const box = await rows.nth(i).boundingBox();
        expect(box, `${testId} row ${i} has no box`).not.toBeNull();
        expect(box!.height, `${testId} row ${i} height`).toBeGreaterThanOrEqual(24);
      }
    }

    // The squash's signature is scrollHeight === clientHeight on a list whose
    // content plainly does not fit: the rows absorbed the overflow. Both lists
    // are seeded past their caps, so both must genuinely overflow.
    for (const testId of ["project-recent-list", "project-fs-list"]) {
      const { client, scroll } = await metrics(page, testId);
      expect(client, `${testId} collapsed`).toBeGreaterThan(60);
      expect(scroll, `${testId} did not overflow`).toBeGreaterThan(client + 8);
    }
  });

  test("a scrollable list says so, and stops saying so at its end", async ({ page }) => {
    await openSeededPicker(page);
    const list = page.getByTestId("project-recent-list");
    const mask = async (): Promise<string> =>
      list.evaluate((el) => getComputedStyle(el).webkitMaskImage || getComputedStyle(el).maskImage);

    // Overflowing and at the top: the bottom fade is the only cue macOS's
    // overlay scrollbars leave room for, so it has to be on.
    expect(await mask()).toContain("gradient");
    await list.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect
      .poll(async () => await mask(), { message: "fade should clear at the end" })
      .not.toContain("gradient");
  });

  test("the card stays inside the viewport", async ({ page }) => {
    await openSeededPicker(page);
    const card = await page.getByTestId("project-picker").boundingBox();
    const viewport = page.viewportSize()!;
    expect(card).not.toBeNull();
    expect(card!.y).toBeGreaterThanOrEqual(0);
    expect(card!.y + card!.height).toBeLessThanOrEqual(viewport.height + 1);
  });

  test("the lists scroll with the keyboard and Enter opens the focused row", async ({ page }) => {
    await openSeededPicker(page);
    const rows = page.getByTestId("project-recent");
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rows.first()).toBeFocused();

    // Arrow-ing to the end must scroll the list, not walk off it.
    for (let i = 0; i < RECENTS.length; i++) await page.keyboard.press("ArrowDown");
    await expect(rows.nth(RECENTS.length - 1)).toBeFocused();
    const scrolled = await page
      .getByTestId("project-recent-list")
      .evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
  });
});
