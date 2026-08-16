/** Public Draft facade assembled from focused domain modules. */
export {
  audit, concat, empty, insertAfter, insertBefore, isDraft, print, remove,
  replace, replaceEach, replaceWith,
} from "./Model.ts"
export type { EditRangeOptions, ProposedEdit, Replacement } from "./Model.ts"
export * from "./Files.ts"
export * from "./Imports.ts"
export * from "./Arguments.ts"
export * from "./Declarations.ts"
export * from "./ObjectLiteral.ts"
export * from "./Symbols.ts"
export * from "./Cleanup.ts"

import { args, replaceArgument, wrapArgument } from "./Arguments.ts"
import { cleanUnused } from "./Cleanup.ts"
import { classes, functions, interfaces } from "./Declarations.ts"
import { files } from "./Files.ts"
import { imports } from "./Imports.ts"
import { audit, concat, empty, insertAfter, insertBefore, print, remove, replace, replaceEach, replaceWith } from "./Model.ts"
import { objectLiteral } from "./ObjectLiteral.ts"
import { renameSymbol, renameSymbolNamed } from "./Symbols.ts"
import type { Draft as DraftModel } from "./Model.ts"

export type Draft = DraftModel

export const Draft = {
  empty, concat, audit, replace, replaceWith,
  replaceArgument,
  wrapArgument,
  remove, insertBefore, insertAfter, print, replaceEach,
  renameSymbol, renameSymbolNamed, cleanUnused, files, imports,
  interfaces, classes, functions, args, arguments: args, objectLiteral,
}
