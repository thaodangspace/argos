# Spike: hosting Argos tasks on pi-durable 1.5.2

Date: 2026-11-12 · Package: `@earendil-works/pi-durable@1.5.2` · Scope: Phase 4 of
`03_impl_argos_yaml_playbook_engine.md` (FR2/FR13/FR29, D4–D7).

Everything below was confirmed by running throwaway scripts against a temp
`openNodeSqliteStorage` database (the scripts are deleted; the assertions live on in
`packages/core/test/durable/*`). The goal was to answer five questions before writing the host:
does a task need an owner, does `waiting`/`sleeping` survive a reopen, does a `running` task re-run
its phase, can a document and a task be written atomically, and which parts of `Harness.open`
touch `models`.

## 1. `tx.createTask` requires `ownership` (and fails badly without it)

Typed as required, and at runtime a missing owner is an internal `TypeError`, not a clean error:

```ts
await harness.commit((tx) => tx.createTask(Run, { id: "no-own" }), ctx);
// TypeError: Cannot read properties of undefined (reading 'submissionIds')

await harness.commit(
  (tx) => tx.createTask(Run, { id: "ok" }, { ownership: { kind: "conversation" }, conversationId: root.id }),
  ctx,
); // accepted
```

Consequences for Argos (D5):

- run tasks are `ownership: { kind: "conversation" }` + `conversationId: root.id` (the host
  conversation returned by `harness.root()`); omitting `conversationId` on a `Session.commit()`
  is not allowed because that commit is not bound to a conversation;
- step tasks are `ownership: { kind: "task", taskId: runTask.id }`, which is what makes the run
  wait for them and what makes a failed run abort them bottom-up.

`TaskId` is a **branded number** (`type Id<Kind, Type = unknown> = number & {...}`), not a string.
Checkpoints therefore store task ids as numbers (`childTasks: Record<stepId, TaskId>`); the mirrored
document and the future RPC surface stringify them.

## 2. Sleeping and waiting survive close/reopen

Script: a task whose `wait` phase commits `runtime.sleepUntil(now + 10_000, { phase: "wake" })`,
plus a second task blocked in its phase. Close, reopen the same SQLite file, inspect before
`resume()`:

```text
h1 inspect: [["spike.sleeper","sleeping",1794420733029],["spike.blocked","running",null]]
sleeper after reopen before resume: sleeping checkpoint={"phase":"wake"}
no generation task on reopen: spike.blocked,spike.sleeper
```

- the sleeping task's `until` and checkpoint are stored; it resumes at `wake` when the harness
  clock reaches the deadline;
- a `waiting` parent (`{ status: "waiting", on: [...], policy: "allSettled" }`) resumes at its
  committed phase when every child is terminal;
- `harness.open()` performs recovery but does **not** schedule; `harness.resume()` (or a
  submit/wait) starts the scheduler. `ArgosHost.open()` calls `resume()` at the end (FR29).

## 3. A `running` task re-runs its current phase after a reopen

Before close the blocked task is `running`; after reopen and before `resume()` it is `pending`
with the same checkpoint, and after `resume()` its phase runs from the top:

```text
blocked before close: running checkpoint={"phase":"work"}
blocked after reopen before resume: pending checkpoint={"phase":"work"} restarts=undefined
blocked work attempt 2
```

So "locate before launch" is the correct shape: whatever was committed before the crash is the
resume point. A crash between the launch-intent commit and the `agentId` commit re-enters
`launch` and calls the executor again; the `requestId` in the checkpoint is unchanged, which is
why `launch` must adopt by `requestId` instead of creating a second agent.

**Close waits for running phase code.** A phase that awaits an external promise forever makes
`harness.close()` hang ("Closing waits for running task code to return"). `argos.step` therefore
races `launch`/`status`/`collect` against `runtime.signal`; the abort rejects the phase, close
returns, and the committed checkpoint stays intact. The same 20-line helper is used in the tests
(`packages/core/test/durable/durability.test.ts`).

## 4. Committing `{ status: "running", checkpoint: { phase: "next" } }` chains phases

This is the mechanism behind `select → await → settle → gate → done` in a single task:

```ts
a: async (task, runtime, context) => {
  await runtime.commit(async (tx) => {
    const children = [];
    for (const n of [1, 2]) {
      children.push(await tx.createTask(Child, { n }, { ownership: { kind: "task", taskId: task.id } }));
    }
    return { status: "running", checkpoint: { phase: "b", children } };
  }, context);
},
b: async (task, runtime, context) => {
  const live = await runtime.ownedTasks(context);   // sees the children from the same commit
  await runtime.commit(() => ({
    status: "waiting",
    checkpoint: { phase: "c", children: task.state.checkpoint.children },
    on: task.state.checkpoint.children,
    policy: "allSettled",
  }), context);
},
```

Observed:

```text
parent a
parent b (phase rerun reached); children=2
live owned: spike.child:running, spike.child:running
parent c outcomes: completed,failed(boom)
```

`runtime.ownedTasks()` returns the live children created in the same commit or in an earlier
lifetime; `runtime.outcomes(ids)` after the wait returns each `TaskOutcome`, including
`{ status: "failed", error: { message } }`. A failed run outcome aborts owned work automatically,
which is what we rely on for a failed `argos.run`.

## 5. Documents and tasks are atomic in one commit

`tx.doc(Family, key, seed)` creates the document on first use (the seed is only passed to
`initial(seed)`) and updates it in place afterwards. Writing the task state and both documents in
the same `runtime.commit()` stores one commit, so the mirror cannot lag the checkpoint (FR13):

```ts
await runtime.commit(async (tx) => {
  const doc = await tx.doc(RunDoc, task.input.id, seed);
  doc.record = record;
  return { status: "running", checkpoint: next };
}, context);
```

A surprise worth writing down: **Chord omits a document change when the new value is identical**
to the stored one. The commit still stores the task checkpoint, but the publication has no
`document.change` for that document (observed while instrumenting the mirror test: commits that
only advanced the phase had `doc=false`). The mirror test treats that as "record unchanged" and
verifies the checkpoint record still equals the last mirrored record, instead of assuming one
document change per task commit.

## 6. `Harness.open` touches `models.getAuth`

`Harness.open` wraps `options.models` in a client-identity proxy immediately. A naive
"throw on any property access" Proxy breaks open:

```text
Error: stub models touched: getAuth
  at withClientIdentity (pi-ai/dist/utils/identity.js)
  at currentModels (pi-durable/dist/harness/harness.js)
```

The D6 stub must therefore return a callable for `getAuth` (which throws when **called**) and a
`has` trap that reports `false`, so `withClientIdentity` treats it as immutable:

```ts
return new Proxy({}, {
  get: (_target, property) =>
    typeof property === "symbol" || property === "then" || property === "toJSON"
      ? undefined
      : () => { throw new Error("argos: no model access"); },
  has: () => false,
}) as unknown as Models;
```

With that stub, no `pi.generation` task ever appears in `harness.inspect()`, which the guard test
asserts at every scheduling round (`packages/core/test/durable/host.test.ts`).

## Other facts used by the implementation

- `harness.close(context)` seals admission, settles commits, and closes storage; do not close the
  `Storage` again.
- `harness.snapshot(Family, key, context)` returns a frozen document or `undefined`; it is safe to
  call from a host that only reads (the future RPC layer).
- `runtime.commit()` rejects once the invocation ended, so every phase must treat a rejection
  during close as "stop", not as a run failure.
- `defineTask` infers the checkpoint type from `initial()`. `S` must be a **discriminated union**
  (`{phase:"a"} | {phase:"b"} | …`), because each phase handler receives
  `RunningTask<I, Extract<S, {phase: P}>, R>`; one interface with `phase: "a" | "b"` narrows to
  `never` and every `task.state.checkpoint` access fails to typecheck.
