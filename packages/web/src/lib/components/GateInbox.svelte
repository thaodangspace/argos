<script lang="ts">
  /**
   * The cross-run gate inbox (inbox FR3, FR4, FR10): every pending gate, oldest first, with the run
   * context a decision needs and the existing `GateCard` for the decision itself.
   *
   * A card's disabled state comes from `entry.gate.deciding`, which the projection sets from the
   * `deciding` prop, so there is no second `busy` source to keep in sync (inbox FR5).
   *
   * The hidden-workflow preference is deliberately not an input (inbox FR9): the rail hides list
   * rows, never work that waits for a person.
   */
  import type { RunSummary } from "@thaodangspace/argos-core/rpc/contracts";
  import { RUN_TRIGGER_LABELS, shortId } from "@thaodangspace/argos-core/view";

  import { gateInbox, type GateInboxEntry } from "#lib/gate-inbox";
  import { stepHref } from "#lib/paths";

  import EmptyState from "./EmptyState.svelte";
  import GateCard from "./GateCard.svelte";

  let {
    runs,
    loaded,
    now,
    timeZone,
    deciding,
    onDecide,
  }: {
    runs: readonly RunSummary[];
    /** The first read succeeded: an empty inbox is then real, not "not loaded yet". */
    loaded: boolean;
    /** The render instant for the age labels; the page's ticker advances it. */
    now: number;
    /** The reader's IANA zone for the absolute open time (inbox FR8); `undefined` is the runtime's. */
    timeZone: string | undefined;
    /** Gate keys (`<runId>.<gateId>`) with a decision in flight. */
    deciding: readonly string[];
    onDecide: (
      entry: GateInboxEntry,
      decision: string,
      comment: string | undefined,
    ) => Promise<void>;
  } = $props();

  const entries = $derived(gateInbox(runs, { now, timeZone, deciding }));

  const CONTEXT = "mb-1.5 flex flex-wrap items-baseline gap-1.5 text-[12px] text-surface-600-400";
</script>

{#if entries.length === 0}
  {#if loaded}
    <EmptyState
      title="No gates waiting"
      hint="A gate opens when a playbook step asks for a human decision, and it leaves this page the moment someone decides it. In a shell, `argos gates` lists the same queue."
    />
  {:else}
    <div class="p-8 text-center text-surface-600-400" aria-busy="true">Loading gates…</div>
  {/if}
{:else}
  <ul class="m-0 list-none p-0" aria-label="Pending gates">
    {#each entries as entry (entry.key)}
      <li class="mb-4">
        <div class={CONTEXT}>
          <span class="font-semibold text-surface-950-50">{entry.run.playbookId}</span>
          <span class="opacity-50" aria-hidden="true">·</span>
          <span>{entry.run.project}</span>
          <span class="opacity-50" aria-hidden="true">·</span>
          <span class="font-mono">#{shortId(entry.run.id)}</span>
          <span class="opacity-50" aria-hidden="true">·</span>
          <span class="capitalize">{RUN_TRIGGER_LABELS[entry.run.triggerFacet]}</span>
          <span class="rounded bg-surface-500/15 px-1.5" data-tone="neutral"
            >{entry.run.executor}</span
          >
          <span class="flex-1"></span>
          <span class="font-mono">waiting {entry.ageLabel}</span>
          {#if entry.sinceLabel !== ""}
            <span class="font-mono text-surface-600-400">{entry.sinceLabel}</span>
          {/if}
        </div>
        <p class="mt-0 mb-1.5 text-[12px]">
          <a class="text-primary-700-300 hover:underline" href={stepHref(entry.run.id, entry.run.stepId)}
            >Open step {entry.run.stepId}</a
          >
        </p>
        <GateCard
          gate={entry.gate}
          onDecide={(decision, comment) => onDecide(entry, decision, comment)}
        />
      </li>
    {/each}
  </ul>
{/if}
