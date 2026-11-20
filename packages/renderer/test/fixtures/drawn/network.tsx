import React, { useEffect } from "react";
import { AbsoluteFill } from "remotion";

// BYPASSES the static check on purpose: `fetch`, `<img>`, `Image` and a CSS
// url() to another origin are exactly what the check rejects, and this
// fixture exists to prove the policy stops them when the check is fooled.
// drawn-render.test.ts writes it into a temp workdir with __PROBE__ replaced
// by the probe server's origin. The data: square must still paint: the
// policy blocks other origins, not inline data.
const RED_PIXEL =
  "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#ff0000"/></svg>');

export default function Scene() {
  useEffect(() => {
    fetch("__PROBE__/fetch").catch(() => {});
    new Image().src = "__PROBE__/image-js";
  }, []);
  return (
    <AbsoluteFill>
      <img src="__PROBE__/img-tag" width={10} height={10} />
      <div style={{ width: 100, height: 100, backgroundImage: "url(__PROBE__/css)" }} />
      <img src={RED_PIXEL} style={{ position: "absolute", left: 0, top: 0, width: 200, height: 200 }} />
    </AbsoluteFill>
  );
}
