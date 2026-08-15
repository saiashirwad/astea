# Establish the proof-of-concept harness

Type: task
Status: resolved

## Comments

- Claimed to establish the minimal pinned pnpm harness before any public API design begins.

## Question

Create the smallest pnpm TypeScript project that can run repeatable tests and executable experiments against pinned Effect v4 and TypeScript 7 dependencies. It must support spawning `typescript/unstable/async` against fixture projects without prematurely choosing the library's public module structure. Record the exact versions and commands that later prototype tickets can rely on.

## Answer

The repository now has a deliberately small, pinned harness:

- Node.js 24 or later and pnpm 11.17.0.
- TypeScript 7.0.2, imported through `typescript/unstable/async`.
- Effect 4.0.0-rc.109. The older beta tag had an internally inconsistent declaration build under TypeScript 7; the current v4 RC type-checks cleanly.
- Vitest 4.1.10 and tsx 4.23.12 for repeatable checks and executable experiments.

The throwaway experiment in `src/prototype/native-api.ts` creates the native `API` against a filesystem directory, opens `fixtures/basic/tsconfig.json` with `updateSnapshot`, obtains its project and program, enumerates source files, requests semantic diagnostics, and explicitly disposes the snapshot and compiler process. The Vitest check proves the fixture source belongs to the opened program and has zero semantic diagnostics.

The supported commands are:

```sh
pnpm install
pnpm check
pnpm test
pnpm prototype:native
```

All three verification commands pass. This settles only that the selected toolchain and native filesystem lifecycle are executable; it does not establish the future public API or resource model.
