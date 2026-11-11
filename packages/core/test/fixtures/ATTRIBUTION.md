# Fixture attribution

The files under `compat/.paseo/plugins/playbooks/` are copied verbatim from
[`lerenn/paseo-playbooks`](https://github.com/lerenn/paseo-playbooks), used here as golden
compatibility fixtures (plan decision D13).

- Source repository: https://github.com/lerenn/paseo-playbooks
- Commit: `0e1290ec54cb22ca7843db51109dc32177c82993` (2026-11-11)
- License: MIT (see the upstream repository's `LICENSE`)
- Copied files:
  - `docs.yaml` — `<repo>/.paseo/plugins/playbooks/docs.yaml`
  - `pr.yaml` — `<repo>/examples/.paseo/plugins/playbooks/pr.yaml`
  - `defaults/main.yaml` — `<repo>/examples/.paseo/plugins/playbooks/defaults/main.yaml`
  - `roles/{investigator,implementer,reviewer,local_qa,babysitter,gatekeeper}/` —
    `<repo>/examples/.paseo/plugins/playbooks/roles/<id>/`
  - `roles/{doc_investigator,doc_writer,doc_reviewer,consistency_checker,doc_editor}/` —
    `<repo>/.paseo/plugins/playbooks/roles/<id>/`

Only this attribution note, the fixture layout (the upstream `.paseo/plugins/playbooks`
directory, which exercises Argos' compatibility fallback), and the two selected playbooks
differ from upstream. File contents are unmodified.

`docs.yaml` and `pr.yaml` were chosen because together they exercise `steps`, `needs`
(including parallel branches), `on`, `outcomes`, `goto` + `max_loops`, `gate` + `choices`,
`inputs` (list and map forms), `outputs` (including `value`), `role` blocks, `agent`
overrides, `manager`, `retries`, and `timeout`.

The MIT license text is at the upstream repository; the copy is redistributed under the same
terms.
