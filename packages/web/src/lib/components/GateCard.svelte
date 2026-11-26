<script lang="ts">
  import type { GateChoiceView, GateView, StatusTone } from "@thaodangspace/argos-core/view";

  import { TONE_TEXT, toneClass } from "#lib/ui/tone";

  let {
    gate,
    onDecide,
    busy = false,
  }: {
    gate: GateView;
    onDecide: (decision: string, comment?: string) => Promise<void>;
    busy?: boolean;
  } = $props();

  let comment = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const disabled = $derived(busy || submitting || gate.deciding);
  // One page can hold the same `gateId` of two runs (`fix:1`), so both ids carry the run too
  // (inbox FR7). The run page passes the same view and needs no change.
  const questionId = $derived(`gate-${gate.runId}-${gate.gateId}`);
  const needsComment = $derived(gate.choices.some((choice) => choice.comment === "required"));

  // A waiting gate is the page's one warning surface; a decided one is a plain card (spec FR13).
  const SURFACE = $derived(
    gate.status === "pending"
      ? "card mb-3 border border-warning-500/40 bg-warning-500/15 p-3"
      : "card mb-3 border border-surface-200-800 bg-surface-100-900 p-3",
  );

  // One literal per tone: a primary/approve choice reads filled, everything else is outlined.
  const CHOICE: Readonly<Record<StatusTone, string>> = {
    neutral: "btn btn-sm preset-outlined-surface-500",
    accent: "btn btn-sm preset-filled-primary-500",
    success: "btn btn-sm preset-filled-success-500",
    warning: "btn btn-sm preset-outlined-warning-500",
    danger: "btn btn-sm preset-outlined-error-500",
  };

  async function choose(choice: GateChoiceView): Promise<void> {
    if (disabled) return;
    const text = comment.trim();
    if (choice.comment === "required" && text === "") {
      error = "This decision needs a comment.";
      return;
    }
    error = null;
    submitting = true;
    try {
      await onDecide(choice.id, text === "" ? undefined : text);
    } finally {
      submitting = false;
    }
  }
</script>

<!-- The `<article>` and the question's `gate-<runId>-<gateId>` id are the card's accessible name
     (spec FR14, inbox FR7): the id is what `aria-labelledby` points at. -->
<article class={SURFACE} aria-labelledby={questionId}>
  <header
    class="flex flex-wrap items-center gap-2 text-[11px] tracking-[0.04em] text-surface-600-400 uppercase"
  >
    <span class="badge preset-tonal-warning"
      >{gate.kind === "loop_limit" ? "Loop limit" : gate.kind === "ask" ? "Question" : "Gate"}</span
    >
    <code class="font-mono tracking-normal normal-case">{gate.gateId}</code>
    <span class="font-mono normal-case">step {gate.stepId}</span>
  </header>

  <p id={questionId} class="mt-1.5 mb-2.5 text-sm text-surface-950-50">{gate.question}</p>

  {#if gate.status === "pending"}
    <div class="flex flex-wrap gap-2" role="group" aria-label="Gate choices">
      {#each gate.choices as choice (choice.id)}
        <button
          type="button"
          class={toneClass(CHOICE, choice.tone)}
          data-tone={choice.tone}
          disabled={disabled}
          title={choice.comment === "required" ? "A comment is required" : undefined}
          onclick={() => choose(choice)}
        >
          {choice.label}
          {#if choice.comment === "required"}<span aria-hidden="true">*</span>{/if}
        </button>
      {/each}
    </div>
    <label class="mt-2.5 block">
      <span class="sr-only">Comment</span>
      <textarea
        class="textarea mt-1 w-full"
        bind:value={comment}
        rows="2"
        placeholder={needsComment
          ? "Comment (required for at least one choice)"
          : "Add a comment (optional)"}
        disabled={disabled}
      ></textarea>
    </label>
    {#if error !== null}<p
        class={["mt-1.5 text-[12px]", toneClass(TONE_TEXT, "danger")]}
        data-tone="danger"
        role="alert">{error}</p
      >{/if}
  {:else}
    <p class="m-0 text-[13px]">
      Decided <strong>{gate.decision}</strong>
      {#if gate.key !== ""}<span class="text-surface-600-400">· {gate.gateId}</span>{/if}
    </p>
  {/if}
</article>
