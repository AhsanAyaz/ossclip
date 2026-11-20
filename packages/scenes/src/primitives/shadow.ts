/**
 * The one drop shadow the pattern scenes share (§161). They draw over the
 * speaker with no scrim (plan decision 1), so a card's edge has to separate
 * from whatever the video shows behind it; a single value keeps every card,
 * pill and badge lit from the same place. The only colour literal the
 * primitives carry: a shadow is black at an alpha, not a theme role, and a
 * theme that recoloured it would only make it stop reading as a shadow.
 */
export const SHADOW = "0 12px 32px rgba(0,0,0,0.45)";
