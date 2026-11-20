import React from "react";
import { Img, staticFile } from "remotion";
import { Card as CardPart } from "../primitives/Card";
import { NumberBadge as NumberBadgePart } from "../primitives/NumberBadge";
import { PhoneFrame as PhoneFramePart } from "../primitives/PhoneFrame";
import { Pill as PillPart } from "../primitives/Pill";
import { Sticker as StickerPart } from "../primitives/Sticker";
import { assetFile, useDrawContext } from "./context";

/**
 * The pattern-scene primitives for drawn scenes (§167): the same parts with
 * the same props minus `theme`, which they read from the kit's context. A
 * drawn scene has no theme prop to pass (storyboard design §4), and a scene
 * that picked its own colours would drift off the project's look.
 */
type Themeless<P extends { theme: unknown }> = Omit<P, "theme">;

export const Card: React.FC<Themeless<React.ComponentProps<typeof CardPart>>> = (props) => {
  const { theme } = useDrawContext("<Card>");
  return <CardPart {...props} theme={theme} />;
};

export const Pill: React.FC<Themeless<React.ComponentProps<typeof PillPart>>> = (props) => {
  const { theme } = useDrawContext("<Pill>");
  return <PillPart {...props} theme={theme} />;
};

export const Sticker: React.FC<Themeless<React.ComponentProps<typeof StickerPart>>> = (props) => {
  const { theme } = useDrawContext("<Sticker>");
  return <StickerPart {...props} theme={theme} />;
};

export const NumberBadge: React.FC<Themeless<React.ComponentProps<typeof NumberBadgePart>>> = (props) => {
  const { theme } = useDrawContext("<NumberBadge>");
  return <NumberBadgePart {...props} theme={theme} />;
};

export const PhoneFrame: React.FC<Themeless<React.ComponentProps<typeof PhoneFramePart>>> = (props) => {
  const { theme } = useDrawContext("<PhoneFrame>");
  return <PhoneFramePart {...props} theme={theme} />;
};

// The primitive Icon takes no theme: its caller passes a theme colour as
// `color`. So it is the kit's part as it is, with nothing to wrap.
export { Icon } from "../primitives/Icon";

/**
 * One of the author's files, by name, as an image (storyboard design §4).
 * Kit code, so it may use `Img` and `staticFile`, which a drawn scene may
 * not import: the only file a scene can reach is one the author put in the
 * assets folder. Always an `<img>`, never inlined, so an SVG asset cannot
 * run script.
 *
 * An unknown name renders nothing (plan Task 2) instead of throwing: the
 * name is a string the static and type checks cannot verify, and the stills
 * show a missing asset where an error would fail the whole version.
 */
export const Asset: React.FC<{ name: string; width?: number; height?: number; style?: React.CSSProperties }> = ({
  name,
  width,
  height,
  style,
}) => {
  const { assets } = useDrawContext("<Asset>");
  const file = assetFile(assets, name);
  if (file === null) return null;
  return <Img src={staticFile(file)} width={width} height={height} style={style} />;
};
