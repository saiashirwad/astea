# Define the reliability contract

Type: grilling
Status: resolved
Blocked by: 13

## Comments

- Claimed for a focused decision session defining the non-negotiable reliability guarantees before deeper lifecycle and edit prototypes.
- Round 1 settled three contract levels: non-disableable Reliability Invariants, explicit Plan Policies, and advisory evidence. Deterministic output is byte-identical and canonically ordered for the same snapshot, recipe, options, and toolchain. Stale Plans are rejected rather than rebased. Multi-file application validates and stages all results, reports success only after all writes, and rolls back handled failures; crash atomicity remains unclaimed until a durable protocol is proven.
- Round 2 accepted conflict rejection, explicit scope and cardinality policies, diagnostic comparison, declared idempotence, and deterministic Plan Evidence. Remaining operational defaults were settled without escalating choices that do not shape the recipe-authoring API.

## Question

What must “reliable enough for a large, complex, team-scale codemod” mean in this project? Decide which guarantees are mandatory, configurable, advisory, or deferred across deterministic output, snapshot staleness, overlapping edits, expected match counts, repeatability and idempotence, diagnostic comparison, partial failure, atomic application, evidence, and recovery.

## Answer

Reliability has three distinct levels: non-disableable system invariants, explicit Plan Policies, and advisory operational metadata. A caller cannot weaken an invariant. A Plan Policy may vary by recipe or run, but its value and result must be inspectable. Advisory observations never affect plan identity or application eligibility.

### Reliability Invariants

1. **Explicit application.** Querying, planning, previewing, and Verification perform no project writes. Only Application may change project files.
2. **Deterministic plans and bytes.** The same source bytes, Project Snapshot, recipe implementation and identity, recipe options, toolchain, and declared environment inputs produce the same canonically ordered Transformation Plan and identical resulting file bytes. Absolute workspace location, wall-clock time, scheduling, tracing, and performance measurements cannot affect the plan.
3. **No hidden ordering semantics.** A finalized plan cannot contain overlapping edits or ambiguous same-position insertions. A recipe must compose them into one deterministic edit before finalization or plan construction fails.
4. **Snapshot honesty.** Verification and Application reject a Stale Plan. The system does not silently rebase, refresh, or re-resolve it. Application rechecks snapshot identity and affected-file content immediately before writing.
5. **No partial planning result.** A failed recipe, failed query, ambiguity, conflict, or policy evaluation returns a failure rather than a usable partial plan.
6. **Mandatory Verification before Application.** Application accepts only a plan whose complete proposed next state has passed conflict checks, Plan Policies, parsing, and configured diagnostic checks against the same current snapshot.
7. **Unrelated bytes remain unchanged.** Files outside the finalized plan are untouched. Unedited ranges within an edited file remain byte-for-byte identical unless a future explicitly selected file-level transformation says otherwise.
8. **No false success.** Application reports success only when every planned output has been written and confirmed. It never reports a partially applied plan as successful.
9. **Handled-failure rollback.** All output is computed and staged before the first project write. A handled write failure triggers rollback. If rollback cannot restore every affected file, the outcome is explicitly indeterminate and includes recovery evidence; it is never collapsed into an ordinary failure or success.

### Plan Policies

- Every plan records actual match and affected-file counts. Recipes may assert exact, minimum, maximum, or ranged cardinality; allowed and excluded paths; and maximum touched files. An unconstrained dimension is permitted only when it is explicit and visible.
- Verification always records the complete TypeScript diagnostic delta for the proposed state. The default policy rejects new error diagnostics while tolerating unchanged pre-existing errors. A recipe may explicitly allow an expected diagnostic delta.
- Idempotence is declared rather than universal. When promised, Verification reruns the recipe against the proposed next snapshot and requires an empty second plan. Production codemod recipes should normally promise idempotence; deliberately one-off transformations may explicitly opt out.

### Required Plan Evidence

Every plan explains its declared inputs without relying on logs. Evidence includes source and affected-file fingerprints, Project Snapshot identity, toolchain identity, recipe identity and options, selected matches and why they qualified, the recipe operation responsible for each edit, actual policy measurements and results, and the diagnostic delta. The exact durable representation remains a later design decision.

Timings, memory use, trace identifiers, and scheduling data are advisory metadata. They may be attached to a run but cannot alter deterministic plan identity.

### Explicitly deferred guarantees

- Automatic rebasing or fine-grained reuse of a plan after its Project Snapshot changes.
- Power-loss, process-crash, or machine-crash atomicity until a durable journal and recovery protocol have been designed and proven.
- Distributed application across machines or repositories.
- A serialized Plan Evidence or application-receipt format.

These deferrals do not weaken the no-false-success rule: unsupported failure modes must be stated rather than represented as transactional guarantees.
