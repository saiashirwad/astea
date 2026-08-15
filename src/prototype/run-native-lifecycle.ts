import { Effect } from "effect"
import { layer } from "./native-compiler.ts"
import { inspectNativeLifecycle, makeLifecycleFixture } from "./native-lifecycle.ts"

const report = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const fixture = yield* makeLifecycleFixture
  return yield* inspectNativeLifecycle(fixture).pipe(Effect.provide(layer({
    cwd: fixture.root,
    fs: fixture.overlay,
    collectTiming: true,
  })))
})))

console.log(report)
