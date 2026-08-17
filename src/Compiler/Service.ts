/** Scoped compiler service around TypeScript 7's native async client. */
import { Context, Data, Effect, Layer, type Scope } from "effect"
import { API, type APIOptions, type Snapshot, type TimingInfo } from "typescript/unstable/async"
import type { UpdateSnapshotParams } from "typescript/unstable/proto"

export class NativeCompilerError extends Data.TaggedError("NativeCompilerError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export const nativeRequest = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, NativeCompilerError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new NativeCompilerError({ operation, cause }),
  })

export interface NativeCompilerService {
  readonly openSnapshot: (
    params?: UpdateSnapshotParams,
  ) => Effect.Effect<Snapshot, NativeCompilerError, Scope.Scope>
  readonly getTiming: Effect.Effect<TimingInfo, NativeCompilerError>
  readonly resetTiming: Effect.Effect<void, NativeCompilerError>
}

export class NativeCompiler extends Context.Service<NativeCompiler, NativeCompilerService>()(
  // oxlint-disable-next-line effecttsgo/deterministic-keys -- Stable internal service identifier.
  "@safemods/internal/NativeCompiler",
) {}

export const make = (
  options: APIOptions,
): Effect.Effect<NativeCompiler["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const api = yield* Effect.acquireRelease(
      Effect.sync(() => new API(options)),
      (api) => Effect.promise(() => api.close()),
    )

    const openSnapshot = Effect.fn("NativeCompiler.openSnapshot")((params?: UpdateSnapshotParams) =>
      Effect.acquireRelease(
        nativeRequest("updateSnapshot", () => api.updateSnapshot(params)),
        (snapshot) => Effect.promise(() => snapshot.dispose()),
      ),
    )

    const getTiming: Effect.Effect<TimingInfo, NativeCompilerError> = nativeRequest(
      "getTimingInfo",
      () => api.getTimingInfo(),
    )

    const resetTiming: Effect.Effect<void, NativeCompilerError> = nativeRequest(
      "resetTimingInfo",
      () => api.resetTimingInfo(),
    )

    return NativeCompiler.of({ openSnapshot, getTiming, resetTiming })
  })

export const layer = (options: APIOptions): Layer.Layer<NativeCompiler> =>
  Layer.effect(NativeCompiler, make(options))
