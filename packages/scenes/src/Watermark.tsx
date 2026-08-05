import React from "react";
import type { Theme } from "@ossclip/core/browser";
import type { FrameSize } from "./stage";
import { watermarkLayout } from "./watermark-layout";

/**
 * The opt-in "made with ossclip" wordmark (see watermark-layout.ts for the
 * why and the placement rules). Styled from the THEME's display font and
 * foreground — never hardcoded — so a themed production credits the tool in
 * its own voice.
 *
 * Deliberately invisible to the editor: no `data-edit-id`/`data-edit-scene`
 * (the DOM is the hit-test registry — hitTest.ts walks those attributes, so
 * an untagged node can never become a selection) and `pointerEvents: none`
 * so `elementFromPoint` falls through to whatever the wordmark overlaps. A
 * credit is a produce-time switch, not an editable scene element.
 */
export const Watermark: React.FC<{ theme: Theme; frame: FrameSize }> = ({ theme, frame }) => {
  const l = watermarkLayout(frame);
  return (
    <div
      style={{
        position: "absolute",
        left: l.xPx,
        top: l.yPx,
        fontFamily: theme.fontDisplay,
        fontSize: l.fontPx,
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: theme.fg,
        opacity: l.opacity,
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    >
      {l.text}
    </div>
  );
};
