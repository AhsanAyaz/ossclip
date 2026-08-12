// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectPicker,
  isScrollContinuable,
  nextRowIndex,
  splitRecentPath,
} from "../src/ProjectPicker";

// Tells React this environment expects act()-wrapped updates (no test-utils
// polyfill layer to infer it from, since this is the first test in the repo
// to mount a component rather than call renderToStaticMarkup).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ProjectPicker's first rendering test — same hole SceneLayer had (see
 * scene-layer-structure.test.ts): nothing rendered this file before this
 * task. Covers the one-scroll-region contract from the picker spec section:
 * the browse list carries flex:1/minHeight:0/overflowY:auto and the card
 * no longer declares overflowY:auto — via a real mount (not
 * renderToStaticMarkup) because the listing only appears after the
 * `browse()` effect's fetch resolves.
 */
function fsListing(count: number) {
  return {
    dir: "/home/user",
    parent: "/home",
    isWorkdir: false,
    entries: Array.from({ length: count }, (_, i) => ({
      name: `folder-${i}`,
      path: `/home/user/folder-${i}`,
      isWorkdir: false,
    })),
  };
}

describe("ProjectPicker — one scroll region", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // The only endpoint the component calls (`recent` arrives as a prop,
    // not fetched) is `GET /api/fs`, hit once from the mount effect.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => fsListing(40),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("gives the browse list flex:1/minHeight:0/overflowY:auto and leaves the card without its own scroll", async () => {
    await act(async () => {
      root.render(
        React.createElement(ProjectPicker, {
          recent: [],
          required: true,
          onOpen: async () => null,
          onClose: () => {},
        }),
      );
    });

    // browse()'s fetch -> res.json() chain resolves over a couple of
    // microtask/macrotask turns; poll for the list rather than assume one.
    for (let i = 0; i < 10 && !container.querySelector('[data-testid="project-fs-list"]'); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    const list = container.querySelector('[data-testid="project-fs-list"]') as HTMLElement;
    expect(list).not.toBeNull();
    // jsdom expands the shorthand: flex:1 normalizes to "1 1 0%".
    expect(list.style.flex).toBe("1 1 0%");
    expect(list.style.minHeight).toBe("0");
    expect(list.style.overflowY).toBe("auto");

    const card = container.querySelector('[data-testid="project-picker"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.style.overflowY).toBe("");
  });

  it("caps the recent list's own height so a full list can't starve the browse section below it", async () => {
    const recent = Array.from({ length: 12 }, (_, i) => `/home/user/project-${i}`);
    await act(async () => {
      root.render(
        React.createElement(ProjectPicker, {
          recent,
          required: true,
          onOpen: async () => null,
          onClose: () => {},
        }),
      );
    });

    const list = container.querySelector('[data-testid="project-recent-list"]') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.style.maxHeight).toBe("218px");
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.flexShrink).toBe("0");
    expect(list.className).toContain("ossclip-scroll-list");
  });

  // §138: jsdom has no layout, so it cannot see rows squash — but it can see
  // the two declarations whose absence caused it. The rendered proof is in
  // e2e/picker.spec.ts; this is the cheap guard against someone tidying
  // `flexShrink: 0` away as redundant.
  it("gives every row flexShrink:0 and a minHeight so the list overflows instead of crushing them", async () => {
    await act(async () => {
      root.render(
        React.createElement(ProjectPicker, {
          recent: ["/home/user/a/b/project-one", "/home/user/a/b/project-two"],
          required: true,
          onOpen: async () => null,
          onClose: () => {},
        }),
      );
    });
    for (let i = 0; i < 10 && !container.querySelector('[data-testid="project-fs-dir"]'); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    const rows = container.querySelectorAll<HTMLElement>(".ossclip-picker-row");
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.style.flexShrink).toBe("0");
      expect(parseInt(row.style.minHeight, 10)).toBeGreaterThanOrEqual(34);
      // The colours live in index.css so :hover/:focus can win; an inline
      // background here would silently kill both.
      expect(row.style.background).toBe("");
    }
  });
});

describe("splitRecentPath", () => {
  it("keeps the distinguishing tail whole and demotes the shared prefix", () => {
    expect(splitRecentPath("/Users/me/work/clients/acme/episode-01/.ossclip/render")).toEqual({
      head: "/Users/me/work/clients/acme",
      tail: "episode-01/.ossclip/render",
    });
  });

  it("returns no head when the path is all tail", () => {
    expect(splitRecentPath("a/b/c")).toEqual({ head: "", tail: "a/b/c" });
    expect(splitRecentPath("project")).toEqual({ head: "", tail: "project" });
  });

  it("renders the root as / rather than an empty head", () => {
    // "/a/b/c".split("/") is ["", "a", "b", "c"] — the head is the empty
    // leading segment, which must not render as nothing at all.
    expect(splitRecentPath("/a/b/c")).toEqual({ head: "/", tail: "a/b/c" });
  });
});

describe("nextRowIndex", () => {
  it("clamps at both ends rather than wrapping", () => {
    expect(nextRowIndex(0, -1, 5)).toBe(0);
    expect(nextRowIndex(4, 1, 5)).toBe(4);
    expect(nextRowIndex(2, 1, 5)).toBe(3);
    expect(nextRowIndex(2, -1, 5)).toBe(1);
  });

  it("enters the list at the top when nothing in it is focused", () => {
    expect(nextRowIndex(-1, 1, 5)).toBe(0);
    expect(nextRowIndex(-1, -1, 5)).toBe(0);
  });

  it("has no row to land on in an empty list", () => {
    expect(nextRowIndex(-1, 1, 0)).toBe(-1);
  });
});

describe("isScrollContinuable", () => {
  it("is off for a list that fits", () => {
    expect(isScrollContinuable({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 })).toBe(false);
  });

  it("is on for a list with more below the fold", () => {
    expect(isScrollContinuable({ scrollTop: 0, clientHeight: 200, scrollHeight: 400 })).toBe(true);
  });

  it("is off once scrolled to the end, including a sub-pixel shortfall", () => {
    expect(isScrollContinuable({ scrollTop: 200, clientHeight: 200, scrollHeight: 400 })).toBe(
      false,
    );
    expect(isScrollContinuable({ scrollTop: 199.6, clientHeight: 200, scrollHeight: 400 })).toBe(
      false,
    );
  });
});
