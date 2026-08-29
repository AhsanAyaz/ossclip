// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOT_CONFIGURED_MESSAGE,
  PublishPanel,
  SCHEDULE_PRESETS,
  formatMinSec,
  overCapNote,
  panelCaptionCap,
  scheduleIso,
  toLocalInputValue,
  type PublishInfo,
} from "../src/PublishPanel";

// Same mount conventions as youtube-panel.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("scheduleIso", () => {
  it("empty means publish-now (null), garbage is null, a real time normalizes to ISO", () => {
    expect(scheduleIso("")).toBeNull();
    expect(scheduleIso("   ")).toBeNull();
    expect(scheduleIso("whenever")).toBeNull();
    expect(scheduleIso("2026-09-01T08:00")).toBe(new Date("2026-09-01T08:00").toISOString());
  });
});

describe("formatMinSec / overCapNote", () => {
  it("formats seconds as M:SS", () => {
    expect(formatMinSec(320)).toBe("5:20");
    expect(formatMinSec(300)).toBe("5:00");
  });

  it("annotates only a KNOWN duration strictly over a KNOWN cap", () => {
    expect(overCapNote(320, 300)).toBe("video 5:20 > 5:00 cap");
    // At the cap is what the cap permits.
    expect(overCapNote(300, 300)).toBeNull();
    // Unknown duration or an uncapped platform must not gray out a channel
    // on a guess — the server still refuses over-cap picks on POST.
    expect(overCapNote(null, 300)).toBeNull();
    expect(overCapNote(undefined, 300)).toBeNull();
    expect(overCapNote(320, null)).toBeNull();
    expect(overCapNote(320, undefined)).toBeNull();
  });
});

describe("panelCaptionCap", () => {
  it("mirrors core's caps — x 280, unknown falls back to 1500", () => {
    expect(panelCaptionCap("x")).toBe(280);
    expect(panelCaptionCap("mastodon")).toBe(1500);
  });
});

describe("schedule presets", () => {
  // The field is a native datetime-local, which reads as a text mask — the
  // presets and the click-to-open picker are what make it feel pickable
  // (2026-08-29). The VALUE must be local wall-clock text: an ISO string
  // would shift the user's slot by their UTC offset and the input would
  // reject it outright.
  it("formats local wall-clock, not UTC", () => {
    const d = new Date(2026, 7, 29, 18, 5);
    expect(toLocalInputValue(d)).toBe("2026-08-29T18:05");
  });

  it("tomorrow 9am is the next day at 09:00 local", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.label === "Tomorrow 9am")!;
    expect(preset.at(new Date(2026, 7, 29, 23, 40))).toBe("2026-08-30T09:00");
  });

  it("in an hour rolls the date over midnight", () => {
    const preset = SCHEDULE_PRESETS.find((p) => p.label === "In an hour")!;
    expect(preset.at(new Date(2026, 7, 29, 23, 30))).toBe("2026-08-30T00:30");
  });

  it("every preset parses back through scheduleIso", () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(scheduleIso(preset.at(new Date(2026, 7, 29, 12, 0)))).not.toBeNull();
    }
  });
});

describe("PublishPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(PublishPanel, { onClose: () => {} }));
    });
    for (let i = 0; i < 10 && container.querySelectorAll("[data-testid]").length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const ready: PublishInfo = {
    configured: true,
    reachable: true,
    packAvailable: true,
    outPathExists: true,
    receipt: null,
    integrations: [
      { id: "a", provider: "linkedin", name: "Ahsan", caption: "authored linkedin post" },
      // A company PAGE alongside the profile: one network, one caption box
      // (publishGroups.ts). The publish request must still carry the text
      // under BOTH integration ids.
      { id: "p", provider: "linkedin-page", name: "Code with Ahsan", caption: "authored linkedin post" },
      { id: "b", provider: "x", name: "Ahsan", caption: "short x post" },
    ],
  };

  const stubGet = (info: PublishInfo): void => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => info,
    })) as unknown as typeof fetch;
  };

  it("unconfigured: the hint renders instead of controls", async () => {
    stubGet({ configured: false, reason: "missing postizUrl" });
    await mount();
    expect(container.querySelector('[data-testid="publish-unconfigured"]')?.textContent).toBe(
      NOT_CONFIGURED_MESSAGE,
    );
    expect(container.querySelector('[data-testid="publish-send"]')).toBeNull();
  });

  it("unreachable Postiz renders the labeled hint, not a crash", async () => {
    stubGet({ configured: true, reachable: false, reason: "ECONNREFUSED" });
    await mount();
    expect(container.querySelector('[data-testid="publish-unreachable"]')?.textContent).toContain(
      "ECONNREFUSED",
    );
  });

  it("checking an account reveals its caption prefilled with the server's preview, with a live count", async () => {
    stubGet(ready);
    await mount();
    // Nothing selected: the send button is disabled and no caption shows.
    const send = container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]');
    expect(send?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="publish-caption-linkedin"]')).toBeNull();
    const check = container.querySelector<HTMLInputElement>('[data-testid="publish-chip-a"]');
    await act(async () => {
      check!.click();
    });
    const area = container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]');
    expect(area?.value).toBe("authored linkedin post");
    expect(container.querySelector('[data-testid="publish-count-linkedin"]')?.textContent).toBe(
      // One chip picked, so no fan-out suffix — the count names the CHANNELS
      // this caption will actually post to, not the group's size.
      `${"authored linkedin post".length} / 1500`,
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')?.disabled,
    ).toBe(false);
  });

  it("picking two channels in one group posts to both, with one shared caption", async () => {
    // The correction to the first grouping pass (2026-08-29): the CAPTION is
    // per network, the SELECTION is per channel. Picking two of four LinkedIn
    // channels must post to exactly those two, both carrying the one caption.
    const receipt = {
      backend: "postiz",
      postIds: ["p1"],
      publishedAt: "2026-08-26T12:00:00.000Z",
      when: { kind: "now" as const },
      targets: [{ id: "a", provider: "linkedin", name: "Ahsan" }],
    };
    const bodies: Array<{ integrationIds: string[]; captions: Record<string, string> }> = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, receipt }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-p"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(bodies).toHaveLength(1);
    expect([...bodies[0]!.integrationIds].sort()).toEqual(["a", "p"]);
    // One box, so both ids carry the same text.
    expect(bodies[0]!.captions.a).toBe(bodies[0]!.captions.p);
  });

  it("publish POSTs the picked ids and captions, then shows the receipt", async () => {
    const receipt = {
      backend: "postiz",
      postIds: ["p1"],
      publishedAt: "2026-08-26T12:00:00.000Z",
      when: { kind: "now" as const },
      targets: [{ id: "a", provider: "linkedin", name: "Ahsan" }],
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, receipt }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(bodies[0]).toMatchObject({
      integrationIds: ["a"],
      captions: { a: "authored linkedin post" },
    });
    // Publish-now: no `at` rides along.
    expect((bodies[0] as Record<string, unknown>).at).toBeUndefined();
    expect(container.querySelector('[data-testid="publish-done"]')?.textContent).toContain(
      "Published to 1 account(s)",
    );
  });

  it("an over-cap channel's chip is disabled and annotated with the cap", async () => {
    stubGet({
      ...ready,
      durationSec: 320,
      integrations: [
        { id: "a", provider: "linkedin", name: "Ahsan", caption: "authored linkedin post", durationCapSec: null },
        { id: "t", provider: "threads", name: "Ahsan", caption: "short", durationCapSec: 300 },
      ],
    });
    await mount();
    const threads = container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-t"]');
    expect(threads?.disabled).toBe(true);
    expect(threads?.textContent).toContain("video 5:20 > 5:00 cap");
    // The uncapped channel stays pickable.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')?.disabled,
    ).toBe(false);
  });

  it("while the POST runs, the button and a note say encoding is part of the wait", async () => {
    let resolvePost: (v: unknown) => void = () => {};
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === "POST") {
        // Held open — the encode+upload is synchronous server-side, and this
        // pins what the panel shows during it.
        await new Promise((r) => (resolvePost = r));
        return { ok: true, json: async () => ({ ok: true, receipt: null }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')?.textContent,
    ).toBe("Encoding & publishing…");
    expect(
      container.querySelector('[data-testid="publish-busy-note"]')?.textContent,
    ).toContain("Encoding the delivery file");
    await act(async () => {
      resolvePost(undefined);
    });
  });

  it("a server error rides verbatim into the panel", async () => {
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: false, status: 502, json: async () => ({ error: "Postiz POST /posts failed: 400" }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(container.querySelector('[data-testid="publish-error"]')?.textContent).toContain(
      "Postiz POST /posts failed: 400",
    );
  });

  it("an existing receipt shows the already-published note and labels the button Publish again (force)", async () => {
    const receipt = {
      backend: "postiz",
      postIds: [],
      publishedAt: "2026-08-25T10:00:00.000Z",
      when: { kind: "now" as const },
      targets: [{ id: "a", provider: "linkedin", name: "Ahsan" }],
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, receipt }) };
      }
      return { ok: true, json: async () => ({ ...ready, receipt }) };
    }) as unknown as typeof fetch;
    await mount();
    expect(
      container.querySelector('[data-testid="publish-receipt-note"]')?.textContent,
    ).toContain("2026-08-25T10:00:00.000Z");
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-chip-a"]')!.click();
    });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]');
    expect(send?.textContent).toBe("Publish again");
    await act(async () => {
      send!.click();
    });
    expect((bodies[0] as Record<string, unknown>).force).toBe(true);
  });
});
