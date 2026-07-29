#!/usr/bin/env node
// The published entry point (R18 §90b). The CLI — and the Remotion render
// entry it hands to @remotion/bundler — are TypeScript SOURCES: Remotion
// bundles the composition from .tsx at render time, so shipping sources is
// the design, and tsx runs them. tsx is registered here as a library from
// this package's own dependencies — a plain `#!/usr/bin/env tsx` shebang
// would demand a GLOBAL tsx, which a fresh `npm i -g ossclip` does not have.
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");
