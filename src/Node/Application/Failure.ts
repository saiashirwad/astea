import { ApplicationFailure } from "../../Application/Application.ts"

export const asApplicationFailure = (
  planId: string,
  cause: unknown,
  rolledBack = false,
): ApplicationFailure => new ApplicationFailure({ planId, cause, rolledBack })
