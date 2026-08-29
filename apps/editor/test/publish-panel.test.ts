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
  publishBusyLabel,
  regenNotesSummary,
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

describe("publishBusyLabel", () => {
  it("live percent + ETA while encoding, phase-only while uploading", () => {
    expect(publishBusyLabel({ phase: "encoding", pct: 42, etaSec: 110, speed: 1.6 })).toBe(
      "Encoding 42% · ~1:50 left",
    );
    // No upload ETA to measure server-side — the phase alone is the signal.
    expect(publishBusyLabel({ phase: "uploading", pct: null, etaSec: null, speed: null })).toBe(
      "Uploading…",
    );
  });

  it("names the encoding file when the server says which one — a size-capped publish runs two encodes", () => {
    expect(
      publishBusyLabel({
        phase: "encoding",
        pct: 42,
        etaSec: 110,
        speed: 1.6,
        file: "delivery-1920x1080@2106k.mp4",
      }),
    ).toBe("Encoding delivery-1920x1080@2106k.mp4 42% · ~1:50 left");
    // An older server (or a pre-onStart poll) omits the field — no name.
    expect(publishBusyLabel({ phase: "encoding", pct: 42, etaSec: null, speed: null, file: null })).toBe(
      "Encoding 42%",
    );
  });

  it("degrades instead of printing garbage: missing pieces drop off, null falls back", () => {
    // ffmpeg's warm-up block has no ETA yet.
    expect(publishBusyLabel({ phase: "encoding", pct: 42, etaSec: null, speed: null })).toBe(
      "Encoding 42%",
    );
    expect(publishBusyLabel({ phase: "encoding", pct: null, etaSec: null, speed: null })).toBe(
      "Encoding …",
    );
    // Null = the server reports nothing (cache hit, skip-plan, or the poll
    // hasn't answered yet) — the old static line, never a lie of 0%.
    expect(publishBusyLabel(null)).toBe("Encoding & publishing…");
  });
});

describe("panelCaptionCap", () => {
  it("mirrors core's caps — x 280, unknown falls back to 1500", () => {
    expect(panelCaptionCap("x")).toBe(280);
    expect(panelCaptionCap("mastodon")).toBe(1500);
  });
});

describe("regenNotesSummary", () => {
  it("counts the flood instead of showing it, with singular/plural", () => {
    // The 45-line grounding flood is the bug this line exists for.
    expect(regenNotesSummary(45)).toBe("⚠ 45 words not in the take");
    expect(regenNotesSummary(1)).toBe("⚠ 1 word not in the take");
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

  it("the progress poll's answer renders live on the button and the progress line", async () => {
    let resolvePost: (v: unknown) => void = () => {};
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (init?.method === "POST") {
        // Held open — the poll runs WHILE this is in flight.
        await new Promise((r) => (resolvePost = r));
        return { ok: true, json: async () => ({ ok: true, receipt: null }) };
      }
      if (String(url).includes("/api/publish/progress")) {
        return {
          ok: true,
          json: async () => ({
            progress: { phase: "encoding", pct: 42, etaSec: 110, speed: 1.6 },
          }),
        };
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
    // The first tick fires immediately (no 1s blank stare), so the label is
    // live without advancing timers.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')?.textContent,
    ).toBe("Encoding 42% · ~1:50 left");
    expect(container.querySelector('[data-testid="publish-progress"]')?.textContent).toBe(
      "Encoding 42% · ~1:50 left",
    );
    await act(async () => {
      resolvePost(undefined);
    });
  });

  it("a null progress answer falls back to the static busy label", async () => {
    // A cached delivery file (or delivery: master) never enters the encoding
    // phase — the server answers null and the old line must hold.
    let resolvePost: (v: unknown) => void = () => {};
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (init?.method === "POST") {
        await new Promise((r) => (resolvePost = r));
        return { ok: true, json: async () => ({ ok: true, receipt: null }) };
      }
      if (String(url).includes("/api/publish/progress")) {
        return { ok: true, json: async () => ({ progress: null }) };
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
    expect(container.querySelector('[data-testid="publish-progress"]')?.textContent).toBe(
      "Encoding & publishing…",
    );
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

  it("regenerate POSTs the CURRENT text + instruction, and the result fans out to every group id", async () => {
    // The box's live text — the user's manual edit included — is what the
    // server (and so the model) must see, not the server's original preview.
    const bodies: Array<{ network: string; instruction: string; currentCaption: string }> = [];
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            caption: "rewritten caption",
            usage: "▸ llm: 1 calls · 1,000 in / 100 out tokens",
            notes: ['⚠ grounding: "revenue" — not in the take'],
          }),
        };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    // Edit the caption by hand first — the POST must carry this text.
    const area = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="publish-caption-linkedin"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(area, "hand-edited caption");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const instruction = container.querySelector<HTMLInputElement>(
      '[data-testid="publish-regen-instruction-linkedin"]',
    )!;
    // Empty instruction: the button stays disabled — nothing to apply.
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="publish-regen-linkedin"]',
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(instruction, "the 50 teams figure was an example");
      instruction.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="publish-regen-linkedin"]')!
        .click();
    });
    expect(bodies).toEqual([
      {
        network: "linkedin",
        instruction: "the 50 teams figure was an example",
        currentCaption: "hand-edited caption",
      },
    ]);
    // The rewrite landed in the box, and via the fan-out both LinkedIn ids
    // now carry it — proven by the box after picking the page chip too.
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]')
        ?.value,
    ).toBe("rewritten caption");
    // Usage under the box; the grounding advisory is behind its count toggle
    // (the ~45-line flood, 2026-08-29) — collapsed by default, expandable.
    expect(
      container.querySelector('[data-testid="publish-regen-usage-linkedin"]')?.textContent,
    ).toContain("▸ llm: 1 calls");
    expect(container.querySelector('[data-testid="publish-regen-note-linkedin"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="publish-regen-notes-toggle-linkedin"]',
    )!;
    expect(toggle.textContent).toContain("1 word not in the take");
    await act(async () => {
      toggle.click();
    });
    expect(
      container.querySelector('[data-testid="publish-regen-note-linkedin"]')?.textContent,
    ).toContain('"revenue"');
  });

  it("a regenerate failure rides verbatim into the panel and the caption is untouched", async () => {
    global.fetch = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        return { ok: true, json: async () => ({ ok: false, error: "quota exceeded" }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    const instruction = container.querySelector<HTMLInputElement>(
      '[data-testid="publish-regen-instruction-linkedin"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(instruction, "shorter");
      instruction.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="publish-regen-linkedin"]')!
        .click();
    });
    expect(
      container.querySelector('[data-testid="publish-regen-error-linkedin"]')?.textContent,
    ).toBe("quota exceeded");
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]')
        ?.value,
    ).toBe("authored linkedin post");
  });

  // The batch tests share this: type into an input the way React sees it.
  const setInput = async (el: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  // The batch loop awaits each POST; click returns before it finishes, so
  // the assertions need the timers flushed a few rounds.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  it("batch regenerate hits only the selected networks, one POST at a time", async () => {
    // start/end pairs prove SEQUENTIAL: the server's regenerate is global
    // single-flight and 409s a concurrent call, so interleaved starts would
    // be the real-world failure.
    const events: string[] = [];
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        const body = JSON.parse(init?.body ?? "{}") as { network: string };
        events.push(`start:${body.network}`);
        await new Promise((r) => setTimeout(r, 0));
        events.push(`end:${body.network}`);
        return {
          ok: true,
          json: async () => ({ ok: true, caption: `new ${body.network}`, usage: "u", notes: [] }),
        };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-b"]')!.click();
    });
    const all = container.querySelector<HTMLButtonElement>('[data-testid="publish-regen-all"]')!;
    // Empty shared instruction: nothing to apply, so the button is disabled.
    expect(all.disabled).toBe(true);
    await setInput(
      container.querySelector<HTMLInputElement>('[data-testid="publish-regen-all-instruction"]')!,
      "shorter everywhere",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-regen-all"]')!.click();
    });
    await flush();
    expect(events).toEqual(["start:linkedin", "end:linkedin", "start:x", "end:x"]);
    // Each result fanned into its own group's box.
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]')
        ?.value,
    ).toBe("new linkedin");
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-x"]')?.value,
    ).toBe("new x");
  });

  it("batch skips networks with nothing selected", async () => {
    const networks: string[] = [];
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        networks.push((JSON.parse(init?.body ?? "{}") as { network: string }).network);
        return { ok: true, json: async () => ({ ok: true, caption: "new", usage: "u", notes: [] }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    // Only x picked — linkedin's group has no selected channel, no box, and
    // must cost no LLM call.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-b"]')!.click();
    });
    await setInput(
      container.querySelector<HTMLInputElement>('[data-testid="publish-regen-all-instruction"]')!,
      "shorter",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-regen-all"]')!.click();
    });
    await flush();
    expect(networks).toEqual(["x"]);
  });

  it("a non-empty per-network instruction wins over the shared one during a batch", async () => {
    // A network-specific correction ("drop the emoji on LinkedIn") shouldn't
    // be flattened by the batch's blanket instruction.
    const bodies: Array<{ network: string; instruction: string }> = [];
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, caption: "new", usage: "u", notes: [] }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-b"]')!.click();
    });
    await setInput(
      container.querySelector<HTMLInputElement>(
        '[data-testid="publish-regen-instruction-linkedin"]',
      )!,
      "no emoji here",
    );
    await setInput(
      container.querySelector<HTMLInputElement>('[data-testid="publish-regen-all-instruction"]')!,
      "shorter everywhere",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-regen-all"]')!.click();
    });
    await flush();
    expect(bodies.map((b) => [b.network, b.instruction])).toEqual([
      ["linkedin", "no emoji here"],
      ["x", "shorter everywhere"],
    ]);
  });

  it("one failed network shows its error and the batch continues to the rest", async () => {
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/publish/regenerate")) {
        const body = JSON.parse(init?.body ?? "{}") as { network: string };
        if (body.network === "linkedin") {
          return { ok: true, json: async () => ({ ok: false, error: "quota exceeded" }) };
        }
        return { ok: true, json: async () => ({ ok: true, caption: "new x", usage: "u", notes: [] }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-a"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-chip-b"]')!.click();
    });
    await setInput(
      container.querySelector<HTMLInputElement>('[data-testid="publish-regen-all-instruction"]')!,
      "shorter",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-regen-all"]')!.click();
    });
    await flush();
    // The failure is VISIBLE (never collapsed — it's actionable) and the
    // failed network's caption is untouched…
    expect(
      container.querySelector('[data-testid="publish-regen-error-linkedin"]')?.textContent,
    ).toBe("quota exceeded");
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]')
        ?.value,
    ).toBe("authored linkedin post");
    // …while the network after it still got its rewrite.
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-x"]')?.value,
    ).toBe("new x");
  });

  it("no pack: Generate captions POSTs the endpoint, and success refetches so the controls appear", async () => {
    // The dead-end this button opens (2026-08-29): a render produced without
    // --youtube has no pack, and the modal's only advice was a re-produce.
    let generateCalls = 0;
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (String(url).endsWith("/api/youtube/generate") && init?.method === "POST") {
        generateCalls++;
        return {
          ok: true,
          json: async () => ({ ok: true, usage: "▸ llm: 1 calls · 1,000 in / 100 out tokens" }),
        };
      }
      // The refetch after a successful generate finds the pack in place.
      return { ok: true, json: async () => (generateCalls > 0 ? ready : { ...ready, packAvailable: false }) };
    }) as unknown as typeof fetch;
    await mount();
    // The explanation stays, the button rides with it; no send controls yet.
    expect(container.querySelector('[data-testid="publish-no-pack"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="publish-send"]')).toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="publish-generate-pack"]')!
        .click();
    });
    expect(generateCalls).toBe(1);
    // The refetch replaced the dead-end with the real controls…
    expect(container.querySelector('[data-testid="publish-no-pack"]')).toBeNull();
    expect(container.querySelector('[data-testid="publish-chip-a"]')).not.toBeNull();
    // …and the generation's spend line survives the state swap.
    expect(
      container.querySelector('[data-testid="publish-generate-usage"]')?.textContent,
    ).toContain("▸ llm: 1 calls");
  });

  it("while the generate runs, the button says one LLM call is in flight", async () => {
    let resolveGen: (v: unknown) => void = () => {};
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (String(url).endsWith("/api/youtube/generate") && init?.method === "POST") {
        await new Promise((r) => (resolveGen = r));
        return { ok: true, json: async () => ({ ok: true, usage: "u" }) };
      }
      return { ok: true, json: async () => ({ ...ready, packAvailable: false }) };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="publish-generate-pack"]')!
        .click();
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="publish-generate-pack"]',
    );
    expect(button?.textContent).toBe("Generating captions… (one LLM call)");
    expect(button?.disabled).toBe(true);
    await act(async () => {
      resolveGen(undefined);
    });
  });

  it("a generate failure rides verbatim and the dead-end state stays put", async () => {
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (String(url).endsWith("/api/youtube/generate") && init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: false, error: "quota exceeded" }) };
      }
      return { ok: true, json: async () => ({ ...ready, packAvailable: false }) };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="publish-generate-pack"]')!
        .click();
    });
    expect(
      container.querySelector('[data-testid="publish-generate-error"]')?.textContent,
    ).toBe("quota exceeded");
    expect(container.querySelector('[data-testid="publish-no-pack"]')).not.toBeNull();
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
