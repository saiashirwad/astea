import { describe, effect, expect } from "@effect/vitest"
import { Data, Deferred, Effect, Fiber } from "effect"
import type { Snapshot } from "typescript/unstable/async"
import { make as makeNativeCompiler } from "./internal/NativeCompiler.ts"

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string
}> {}

const dummyFs = {
  readFile: (_fileName: string) => "",
  stat: (_fileName: string) => ({
    isFile: () => true,
    isDirectory: () => false,
    size: 0,
    mtimeMs: 0,
  }),
  readDirectory: (_dirName: string) => [],
}

const trackDisposal = (snapshot: Snapshot, onDispose: () => void) => {
  const originalDispose = snapshot.dispose.bind(snapshot)
  snapshot.dispose = () => {
    onDispose()
    return originalDispose()
  }
}

describe("NativeCompiler lifecycle and resource disposal", () => {
  effect("disposes snapshot on scope success", () =>
    Effect.gen(function* () {
      let snapshotDisposed = false

      yield* Effect.scoped(
        Effect.gen(function* () {
          const compiler = yield* makeNativeCompiler({ fs: dummyFs })

          yield* Effect.scoped(
            Effect.gen(function* () {
              const snapshot = yield* compiler.openSnapshot()
              trackDisposal(snapshot, () => {
                snapshotDisposed = true
              })
              expect(snapshot).toBeDefined()
            }),
          )

          expect(snapshotDisposed).toBe(true)
        }),
      )
    }),
  )

  effect("disposes snapshot on scope failure", () =>
    Effect.gen(function* () {
      let snapshotDisposed = false

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const compiler = yield* makeNativeCompiler({ fs: dummyFs })

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const snapshot = yield* compiler.openSnapshot()
              trackDisposal(snapshot, () => {
                snapshotDisposed = true
              })
              return yield* new TestFailure({ message: "deliberate failure for testing" })
            }),
          )
        }),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(TestFailure)
      expect(snapshotDisposed).toBe(true)
    }),
  )

  effect("disposes snapshot and API on interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotDisposed = false
        const opened = yield* Deferred.make<void>()

        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            const compiler = yield* makeNativeCompiler({ fs: dummyFs })
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const snapshot = yield* compiler.openSnapshot()
                trackDisposal(snapshot, () => {
                  snapshotDisposed = true
                })
                yield* Deferred.succeed(opened, void 0)
                return yield* Effect.never
              }),
            )
          }),
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(opened)
        yield* Fiber.interrupt(fiber)

        expect(snapshotDisposed).toBe(true)
      }),
    ),
  )
})
