import { ApplicationFailure } from "../../Application/Model.ts"

export const asApplicationFailure = (
  planId: string,
  cause: unknown,
  rolledBack = false,
): ApplicationFailure => new ApplicationFailure({ planId, cause, rolledBack })
