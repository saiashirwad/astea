/** PROTOTYPE — Effect Request batching over a TypeScript 7 array checker operation. */
import { Effect, Exit, Request, RequestResolver } from "effect"
import type { Symbol as NativeSymbol } from "typescript/unstable/async"
import { nativeRequest, type NativeCompilerError } from "./native-compiler.ts"
import type { ProjectSnapshot, SnapshotExpired } from "./workspace-snapshot.ts"

export type SymbolLookupError = NativeCompilerError | SnapshotExpired

export interface GetSymbolAtPosition extends Request.Request<
  NativeSymbol | undefined,
  SymbolLookupError
> {
  readonly _tag: "GetSymbolAtPosition"
  readonly fileName: string
  readonly position: number
}

export const GetSymbolAtPosition = Request.tagged<GetSymbolAtPosition>("GetSymbolAtPosition")

export const makeSymbolResolver = (
  project: ProjectSnapshot,
  observeBatch?: (size: number) => void,
): RequestResolver.RequestResolver<GetSymbolAtPosition> => RequestResolver.make(
  Effect.fnUntraced(function*(entries) {
    observeBatch?.(entries.length)
    const first = entries[0]!.request
    const sameFile = entries.every((entry) => entry.request.fileName === first.fileName)
    if (!sameFile) {
      for (const entry of entries) {
        const symbol = yield* project.unsafeNative((nativeProject) => nativeRequest(
          "request symbol at position",
          () => nativeProject.checker.getSymbolAtPosition(entry.request.fileName, entry.request.position),
        ))
        entry.completeUnsafe(Exit.succeed(symbol))
      }
      return
    }

    const symbols = yield* project.unsafeNative((nativeProject) => nativeRequest(
      "request symbols at positions",
      () => nativeProject.checker.getSymbolAtPosition(
        first.fileName,
        entries.map((entry) => entry.request.position),
      ),
    ))
    for (let index = 0; index < entries.length; index++) {
      entries[index]!.completeUnsafe(Exit.succeed(symbols[index]))
    }
  }),
)

export const symbolAtPositionRequest = (
  resolver: RequestResolver.RequestResolver<GetSymbolAtPosition>,
  fileName: string,
  position: number,
): Effect.Effect<NativeSymbol | undefined, SymbolLookupError> =>
  Effect.request(GetSymbolAtPosition({ fileName, position }), resolver)
