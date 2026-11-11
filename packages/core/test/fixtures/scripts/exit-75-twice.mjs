#!/usr/bin/env node
// Phase 7 exit-75 fixture: `SCRIPT_NOT_YET` for the first two executions, then success. The
// counter lives beside the working tree so a re-run (a real process) sees the previous run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const counter = join(process.cwd(), ".argos-test-attempts");
const runs = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(runs));
if (runs < 3) {
  process.stdout.write(`not yet (${runs})\n`);
  process.exit(75);
}
process.stdout.write("done\n");
