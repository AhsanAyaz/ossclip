import React from "react";

// Rendered WITHOUT the static check, on purpose: this fixture tests the render
// path alone. A throw is invisible to the check anyway; the still must fail
// through the host's error boundary, not pass as an empty frame.
export default function Scene() {
  throw new Error("drawn scene exploded on purpose");
  return <div />;
}
