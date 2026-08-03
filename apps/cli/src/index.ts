#!/usr/bin/env tsx
import { buildProgram } from "./program";

// The side effect (loadEnvFiles, R16 §77) stays at import time inside
// program.ts: bin/ossclip.mjs imports this module and expects it to run, and
// this file's first statement importing program.ts is what preserves that
// ordering — before anything reads a provider key.
buildProgram().parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
