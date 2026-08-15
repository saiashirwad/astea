# Decide Transformation Plan durability and evidence

Type: grilling
Status: resolved
Blocked by: 02, 06, 07

## Comments

- Claimed with the default that finalized plans are durable review artifacts, while recipe execution may use a deliberately live draft builder.

## Question

Must a Transformation Plan survive process boundaries, persistence, review, and later resumption, or is it only a live value tied to one compiler session? Decide what must be serializable, which evidence and provenance a plan carries, how it proves its snapshot assumptions, and which capabilities remain deliberately process-local.

## Answer

A finalized Transformation Plan is a durable, canonical, JSON-serializable review artifact. It may be written by one process and previewed, verified, or applied later by another. This is required for agent handoff, human review, CI approval, and resumable large codemods. A live `DraftPlan` may temporarily contain snapshot-bound Selections and authoring state while a recipe runs, but finalization must compile all of that into durable data and reject anything it cannot serialize honestly.

The durable envelope contains:

- schema version and a content-derived Plan ID;
- recipe name, version, implementation hash, canonical options, and declared environment inputs;
- system, TypeScript, and Effect toolchain identities;
- stable project IDs and workspace-relative configuration paths;
- deterministic fingerprints for every project/config/source input capable of affecting semantic results, not only edited files;
- a snapshot hash derived from those canonical fingerprints;
- canonically ordered guarded Text Edits;
- stable evidence IDs, semantic selection facts, Node/Symbol Anchors, and edit provenance;
- explicit Plan Policies and their planning-time measurements.

Absolute workspace paths, native nodes/symbols/types/handles, functions, Effects, Layers, service instances, open file descriptors, compiler process IDs, timestamps, traces, and performance measurements are excluded. Workspace, Workspace Snapshot, filesystem Application, and compiler access remain process-local capabilities supplied when the artifact is used.

Plan identity is a SHA-256 digest of canonical JSON excluding the ID field itself. Object keys and all set-like arrays are canonicalized; absolute location and scheduling cannot affect identity. Deserialization validates the schema and recomputes the digest, so content tampering is rejected. A resumed operation separately recomputes all declared source/toolchain inputs. Any mismatch produces a Stale Plan; anchors do not authorize rebasing.

Verification output and Application receipts should be separate durable artifacts keyed by Plan ID and the exact target snapshot hash. They describe later observations and state changes without mutating the approved plan. Runtime schema migration, signatures/attestation, artifact storage, and compact Merkle manifests are production concerns; the prototype establishes the serialization boundary and identity semantics.

Prototype: [`src/prototype/plan.ts`](../../../src/prototype/plan.ts) and [`src/prototype/plan.test.ts`](../../../src/prototype/plan.test.ts).
