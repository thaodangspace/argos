import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDocFamily } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";

import { createStubModels } from "../../src/durable/host-models.js";

/**
 * D3 (Phase 1 spike): a document write stores the **latest value** of the key, not one revision per
 * write. The future schedule document is rewritten on every fire, so this is the difference
 * between a bounded database and a file that grows by one payload per fire.
 *
 * The family uses exactly the options the schedule family will use: session scope, a family key,
 * and `checkpointWhen: () => true` (a complete base value, never a delta). 1,000 rewrites of a
 * 50-entry payload must keep the database file under 1 MiB — a re-reading of the spike, on the
 * same Node SQLite storage `argos serve` uses.
 */

/** One fire-log entry: about the shape a schedule document keeps 50 of. */
type RevisionsEntry = {
  at: number;
  fireAt: number;
  reason: string;
  status: string;
  runId: string;
  message: string;
};

type RevisionsDocValue = {
  /** The write counter, so every revision really differs. */
  n: number;
  entries: RevisionsEntry[];
};

const RevisionsDocFamily = defineDocFamily<RevisionsDocValue, RevisionsDocValue>({
  kind: "argos.test.revisions",
  version: 1,
  family: true,
  scope: "session",
  initial: (seed) => ({ n: seed.n, entries: seed.entries }),
  checkpointWhen: () => true,
});

const PAYLOAD_ENTRIES = 50;
const WRITES = 1_000;
/** The bound the plan sets: a larger file would mean per-write revision growth. */
const SIZE_LIMIT_BYTES = 1024 * 1024;

function payload(write: number): RevisionsEntry[] {
  return Array.from({ length: PAYLOAD_ENTRIES }, (_unused, index) => ({
    at: 1_780_000_000_000 + write * 1_000 + index,
    fireAt: 1_780_000_000_000 + write * 60_000,
    reason: "cron",
    status: "started",
    runId: `01J${String(write).padStart(6, "0")}${String(index).padStart(12, "0")}`,
    message: `fire ${write}/${index}`,
  }));
}

describe("document revisions stay bounded (D3)", () => {
  it("keeps one latest value per family key, so 1,000 rewrites stay under 1 MiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argos-revisions-"));
    const database = join(dir, "argos.sqlite");
    const storage = await openNodeSqliteStorage(database);
    const harness = await Harness.open(
      storage,
      { models: createStubModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      await harness.root(BACKGROUND_CONTEXT);
      const baseline = statSync(database).size;

      for (let write = 0; write < WRITES; write += 1) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(RevisionsDocFamily, "one", { n: 0, entries: [] });
          doc.n = write;
          doc.entries = payload(write);
        }, BACKGROUND_CONTEXT);
      }

      // The writes landed: the last one is readable as the current value.
      const stored = await harness.snapshot(RevisionsDocFamily, "one", BACKGROUND_CONTEXT);
      expect(stored?.n).toBe(WRITES - 1);
      expect(stored?.entries).toHaveLength(PAYLOAD_ENTRIES);

      const size = statSync(database).size;
      // Not vacuous: the file did grow from the empty database.
      expect(size).toBeGreaterThan(baseline);
      // The point of the test: the file holds one value, not 1,000 revisions of it.
      expect(size).toBeLessThan(SIZE_LIMIT_BYTES);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
