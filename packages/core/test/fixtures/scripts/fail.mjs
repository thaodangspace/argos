#!/usr/bin/env node
// Phase 7 failure fixture: a non-zero exit with output on stderr (the checkpoint keeps the tail).
process.stderr.write("boom: fixture failure\n");
process.exit(3);
