#!/usr/bin/env node
// Phase 7 kill fixture: records its own pid and its child's pid, then never exits, so a test can
// prove that the step timeout and the abort path kill the whole process group (no leaked child).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(join(process.cwd(), "script.pids"), `${process.pid}\n${child.pid}\n`);
setInterval(() => {}, 1000);
