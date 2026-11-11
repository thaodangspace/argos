#!/usr/bin/env node
// Phase 7 env-filter fixture: prints the sorted names of the environment the child received, so a
// test can assert exactly which variables survived `filterScriptEnv` (D10).
process.stdout.write(`${JSON.stringify(Object.keys(process.env).sort())}\n`);
