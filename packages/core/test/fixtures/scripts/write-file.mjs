#!/usr/bin/env node
// Phase 7 read-only guard fixture: a script that writes into its working tree and still exits 0,
// so the guard (not the exit code) has to fail the step.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.cwd(), "script-note.txt"), "written by a script\n");
process.stdout.write("done\n");
