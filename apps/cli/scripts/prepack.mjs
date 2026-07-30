// Copy the built editor page into the package as editor-dist/ before `npm
// pack`. A node script, not `rm -rf && cp -r`, so packing works from a
// Windows shell too.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "editor", "dist");
const dest = join(here, "..", "editor-dist");

if (!existsSync(src)) {
  console.error("apps/editor/dist is missing — the build step before this script failed?");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`prepack: copied ${src} → ${dest}`);
