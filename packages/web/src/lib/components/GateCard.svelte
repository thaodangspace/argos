<script lang="ts">
  import type { GateChoiceView, GateView } from "@thaodangspace/argos-core/view";

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
  const needsComment = $derived(gate.choices.some((choice) => choice.comment === "required"));

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

<article class="gate" class:pending={gate.status === "pending"} aria-labelledby={`gate-${gate.gateId}`}>
  <header>
    <span class="kind">{gate.kind === "loop_limit" ? "Loop limit" : gate.kind === "ask" ? "Question" : "Gate"}</span>
    <code>{gate.gateId}</code>
    <span class="step">step {gate.stepId}</span>
  </header>

  <p id={`gate-${gate.gateId}`} class="question">{gate.question}</p>

  {#if gate.status === "pending"}
    <div class="choices" role="group" aria-label="Gate choices">
      {#each gate.choices as choice (choice.id)}
        <button
          type="button"
          class="choice tone-{choice.tone}"
          disabled={disabled}
          title={choice.comment === "required" ? "A comment is required" : undefined}
          onclick={() => choose(choice)}
        >
          {choice.label}
          {#if choice.comment === "required"}<span aria-hidden="true">*</span>{/if}
        </button>
      {/each}
    </div>
    <label class="comment">
      <span class="sr-only">Comment</span>
      <textarea
        bind:value={comment}
        rows="2"
        placeholder={needsComment
          ? "Comment (required for at least one choice)"
          : "Add a comment (optional)"}
        disabled={disabled}
      ></textarea>
    </label>
    {#if error !== null}<p class="error" role="alert">{error}</p>{/if}
  {:else}
    <p class="decision">
      Decided <strong>{gate.decision}</strong>
      {#if gate.key !== ""}<span class="muted">· {gate.gateId}</span>{/if}
    </p>
  {/if}
</article>

<style>
  .gate {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    padding: 12px;
    margin-bottom: 12px;
  }

  .pending {
    border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
    background: var(--warning-soft);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    text-transform: none;
    letter-spacing: 0;
  }

  .step {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    text-transform: none;
  }

  .question {
    margin: 6px 0 10px;
    font-size: 14px;
    color: var(--text);
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .choice {
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid currentColor;
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }

  .choice:hover:not(:disabled) {
    background: var(--surface-hover);
  }

  .choice:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .comment {
    display: block;
    margin-top: 10px;
  }

  textarea {
    width: 100%;
    resize: vertical;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }

  .error {
    margin: 6px 0 0;
    color: var(--danger);
    font-size: 12px;
  }

  .decision {
    margin: 0;
    font-size: 13px;
  }

  .muted {
    color: var(--muted);
  }
</style>
