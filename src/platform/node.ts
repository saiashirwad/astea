/**
 * Node runtime composition and narrow bootstrap helpers.
 *
 * Application effects should depend on `FileSystem.FileSystem` and `Path.Path`;
 * this module is the composition boundary that selects their Node adapters.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as nodeFsPromises from "node:fs/promises"
import * as path from "node:path"
import { Layer } from "effect"

/** Production Node implementations of Effect's filesystem and path services. */
export const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Provided separately when a caller needs only the path service. */
export const pathLayer = NodePath.layer

/** Direct Node APIs are restricted to process bootstrap and test-fixture setup. */
export { nodeFsPromises, path }
