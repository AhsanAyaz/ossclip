import React from "react";

// Rendered WITHOUT the static check, on purpose: this fixture tests the render
// path alone. It never returns (Review Focus 2), and the still must fail at
// its time limit with the browser torn down.
export default function Scene() {
  let n = 0;
  while (true) {
    n++;
  }
  return <div>{n}</div>;
}
