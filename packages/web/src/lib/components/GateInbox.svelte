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
</script>

{#if entries.length === 0}
  {#if loaded}
    <EmptyState
      title="No gates waiting"
      hint="A gate opens when a playbook step asks for a human decision, and it leaves this page the moment someone decides it. In a shell, `argos gates` lists the same queue."
    />
  {:else}
    <div class="loading" aria-busy="true">Loading gates…</div>
  {/if}
{:else}
  <ul class="inbox" aria-label="Pending gates">
    {#each entries as entry (entry.key)}
      <li class="entry">
        <div class="context">
          <span class="playbook">{entry.run.playbookId}</span>
          <span class="dot" aria-hidden="true">·</span>
          <span class="project">{entry.run.project}</span>
          <span class="dot" aria-hidden="true">·</span>
          <span class="run-id">#{shortId(entry.run.id)}</span>
          <span class="dot" aria-hidden="true">·</span>
          <span class="trigger">{RUN_TRIGGER_LABELS[entry.run.triggerFacet]}</span>
          <span class="executor">{entry.run.executor}</span>
          <span class="spacer"></span>
          <span class="age">waiting {entry.ageLabel}</span>
          {#if entry.sinceLabel !== ""}
            <span class="since">{entry.sinceLabel}</span>
          {/if}
        </div>
        <p class="open">
          <a href={stepHref(entry.run.id, entry.run.stepId)}>Open step {entry.run.stepId}</a>
        </p>
        <GateCard
          gate={entry.gate}
          onDecide={(decision, comment) => onDecide(entry, decision, comment)}
        />
      </li>
    {/each}
  </ul>
{/if}

<style>
  .loading {
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }

  .inbox {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .entry {
    margin-bottom: 16px;
  }

  .context {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .playbook {
    color: var(--text);
    font-weight: 600;
  }

  .run-id,
  .age,
  .since {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  .executor {
    padding: 0 6px;
    border-radius: 4px;
    background: var(--neutral-soft);
  }

  .spacer {
    flex: 1;
  }

  .since {
    color: var(--muted);
  }

  .open {
    margin: 0 0 6px;
    font-size: 12px;
  }

  .open a {
    color: var(--accent);
  }

  .dot {
    color: var(--muted);
  }
</style>
