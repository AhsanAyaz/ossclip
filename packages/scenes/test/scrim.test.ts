import { describe, expect, it } from "vitest";
import {
  LayoutSchema,
  SCENE_REGISTRY,
  defaultTheme,
  kitClipPlans,
  type SceneComponentId,
  type SceneCue,
} from "@ossclip/core";
import { drawsScrim, slotBackdrop } from "../src/scrim";

const COMPONENTS = Object.keys(SCENE_REGISTRY) as SceneComponentId[];
const LAYOUTS = LayoutSchema.options;

/**
 * The clip kit's flat panel (§162, plan decision 2). Off, the backdrop is the
 * scrim rule exactly — every produce/edit/cover render rides on that. On, the
 * frost becomes a flat panel that every non-full-frame, scrim-keeping
 * component gets in every layout.
 */
describe("slotBackdrop", () => {
  it("without flatPanel is drawsScrim exactly, for every component in every layout", () => {
    for (const component of COMPONENTS) {
      for (const layout of LAYOUTS) {
        expect(slotBackdrop(layout, component, false)).toBe(
          drawsScrim(layout, component) ? "scrim" : "none",
        );
      }
    }
  });

  it("with flatPanel never frosts: there is no footage in a kit clip to blur", () => {
    for (const component of COMPONENTS) {
      for (const layout of LAYOUTS) {
        expect(slotBackdrop(layout, component, true)).not.toBe("scrim");
      }
    }
  });

  it("puts a StatCard under the speaker (video-top) on a panel, though video-top has no scrim", () => {
    expect(drawsScrim("video-top", "StatCard")).toBe(false);
    expect(slotBackdrop("video-top", "StatCard", true)).toBe("panel");
    // And in the over-video layouts, where the frost used to be.
    expect(slotBackdrop("full-bleed", "TitleCard", true)).toBe("panel");
    expect(slotBackdrop("lower-third", "TitleCard", true)).toBe("panel");
  });

  it("gives the full-frame pattern scenes and ClipScene nothing in any layout", () => {
    for (const component of ["CardRow", "CtaCard", "BugCard", "PhoneDemo", "ClipScene"] as const) {
      for (const layout of LAYOUTS) {
        expect(slotBackdrop(layout, component, true)).toBe("none");
      }
    }
  });

  it("agrees with core's kit note: 'backdrop replaced by a flat panel' iff the clip draws one", () => {
    // kit-plan.ts restates the rule only to word the report; a note that
    // claims a panel the clip does not draw sends the author looking for one.
    for (const component of COMPONENTS) {
      const meta = SCENE_REGISTRY[component];
      for (const layout of ["graphic-only", "blurred-behind"] as const) {
        const cue: SceneCue = {
          id: "s",
          kind: "graphic",
          layout,
          component,
          props: meta.defaultProps,
          startSec: 0,
          endSec: 4,
        };
        const [plan] = kitClipPlans({
          cues: [cue],
          theme: defaultTheme,
          settings: { width: 1920, height: 1080, fps: 30 },
        });
        const noted = plan!.notes.some((n) => n.startsWith("backdrop replaced by a flat panel"));
        expect(noted, `${component} in ${layout}`).toBe(slotBackdrop(layout, component, true) === "panel");
      }
    }
  });
});
