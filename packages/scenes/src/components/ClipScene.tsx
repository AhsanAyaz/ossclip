import type React from "react";
import type { z } from "zod/v4";
import type { ClipSceneProps, Theme } from "@ossclip/core/browser";

/**
 * PLACEHOLDER until explainer plan Task 7 builds the real component
 * (`OffthreadVideo`, transparent, at `clipVolume(gainDb, muted)`). It exists
 * now only because `ClipScene` joined the scene id enum in Task 3 and the
 * renderer's component map must cover every id. Nothing places a clip scene
 * before Task 8 wires `--script`, so rendering nothing here hides no output.
 */
export const ClipScene: React.FC<{
  props: z.infer<typeof ClipSceneProps>;
  theme: Theme;
}> = () => null;
