# Choose verification and application semantics

Type: prototype
Status: resolved
Blocked by: 02, 03, 06, 07, 09

## Comments

- Claimed to separate read-only preview/verification from write authority and prove stale checks and receipts against temporary project copies.

## Question

How should a plan be previewed, verified against a virtual next project state, compared diagnostically, and applied to disk? Prototype the end-to-end transition and decide validation policy, atomicity, stale-plan rejection, failure reporting, receipts, dry runs, and the separation between planning and write capability.

## Answer

Preview, Verification, and Application are three separate phases with increasing authority.

`preview(plan)` reads but never writes. It validates the complete declared source-fingerprint set, rejects a Stale Plan, validates every old-range hash, applies canonical edits in memory, and returns deterministic before/after file content and hashes suitable for rendering diffs. A dry run is ordinary preview plus Verification; there is no simulated write mode.

Verification evaluates the complete proposed state through a fresh compiler authority over a complete virtual filesystem overlay. The isolated Workspace cannot inherit planning-time decoded nodes, handles, or semantic caches. It runs parsing/configuration checks, obtains the full diagnostic baseline and proposed diagnostic set, evaluates cardinality and affected-file policies, and—when promised—reruns the recipe against the virtual next state and requires an empty second plan. The prototype records counts while the production artifact must retain the complete normalized diagnostic delta. Successful Verification yields a process-local `VerifiedPlan` capability plus a durable Verification Receipt keyed by Plan ID and snapshot hash; it performs no disk writes.

Only the `PlanApplication` Effect service owns write authority. Its `apply(verifiedPlan)` operation immediately rereads and rehashes affected files, computes/stages every output before the first target write, then replaces targets. A handled failure rolls back already replaced files; rollback failure is a distinct `ApplicationIndeterminate`, never an ordinary failure or success. Success returns an Application Receipt containing the Plan ID, snapshot hash, and confirmed output hashes.

The prototype uses same-directory temporary files and rename for each target. It proves explicit writes, stale rejection, staging, handled-failure rollback logic, and receipts, but does not claim power-loss atomicity across multiple files. A durable journal/recovery protocol is required before making that production guarantee. Temporary names, timings, and operation traces do not enter deterministic plan or receipt identity.

Typed failures distinguish stale input, policy/verification failure, recoverable application failure, and indeterminate recovery. Application cannot accept an unverified durable Plan directly. Preview and Verification can be repeated or performed in another process after revalidating all durable assumptions.

Prototype: [`src/prototype/verification.ts`](../../../src/prototype/verification.ts), [`src/prototype/verification.test.ts`](../../../src/prototype/verification.test.ts), and the virtual native compiler proof in [`src/prototype/end-to-end.test.ts`](../../../src/prototype/end-to-end.test.ts).
