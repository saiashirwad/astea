import type { ProjectSnapshot } from "../Workspace/index.ts"
import { args, replaceArgument, wrapArgument } from "./Arguments.ts"
import { classes, functions, interfaces } from "./Declarations.ts"
import { files } from "./Files.ts"
import { imports } from "./Imports.ts"
import {
  audit,
  concat,
  empty,
  insertAfter,
  insertBefore,
  isDraft,
  print,
  remove,
  replace,
  replaceEach,
  replaceWith,
} from "./Model.ts"
import { objectLiteral } from "./ObjectLiteral.ts"
import { cleanUnused } from "./Cleanup.ts"
import { renameSymbol, renameSymbolNamed } from "./Symbols.ts"

const bindProject =
  <Args extends ReadonlyArray<unknown>, A>(
    operation: (project: ProjectSnapshot, ...args: Args) => A,
    project: ProjectSnapshot,
  ): ((...args: Args) => A) =>
  (...args) =>
    operation(project, ...args)

export const forProject = (project: ProjectSnapshot) => ({
  audit,
  concat,
  empty,
  isDraft,
  replaceEach,
  replace: bindProject(replace, project),
  remove: bindProject(remove, project),
  insertBefore: bindProject(insertBefore, project),
  insertAfter: bindProject(insertAfter, project),
  print: bindProject(print, project),
  replaceWith: bindProject(replaceWith, project),
  replaceArgument: bindProject(replaceArgument, project),
  wrapArgument: bindProject(wrapArgument, project),
  args: {
    replaceArgument: bindProject(replaceArgument, project),
    wrapArgument: bindProject(wrapArgument, project),
    wrap: bindProject(args.wrap, project),
    reorder: bindProject(args.reorder, project),
    append: bindProject(args.append, project),
  },
  files: {
    create: bindProject(files.create, project),
    delete: bindProject(files.delete, project),
    move: bindProject(files.move, project),
  },
  imports: {
    addNamed: bindProject(imports.addNamed, project),
    removeNamed: bindProject(imports.removeNamed, project),
    updateSource: bindProject(imports.updateSource, project),
    organize: bindProject(imports.organize, project),
  },
  interfaces: {
    addProperty: bindProject(interfaces.addProperty, project),
    removeProperty: bindProject(interfaces.removeProperty, project),
  },
  classes: {
    addProperty: bindProject(classes.addProperty, project),
    addMethod: bindProject(classes.addMethod, project),
  },
  functions: {
    addParameter: bindProject(functions.addParameter, project),
  },
  objectLiteral: {
    setField: bindProject(objectLiteral.setField, project),
    removeField: bindProject(objectLiteral.removeField, project),
  },
  renameSymbol: bindProject(renameSymbol, project),
  renameSymbolNamed: bindProject(renameSymbolNamed, project),
  cleanUnused: bindProject(cleanUnused, project),
})
