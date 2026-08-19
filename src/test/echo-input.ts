import { Effect } from "effect"
import * as Draft from "../Draft/index.ts"
import * as Recipe from "../Recipe/index.ts"

/** Prints the decoded CLI input so subprocess tests can observe parser behavior. */
export default Recipe.define("echo-input", {
  version: "1.0.0",
  run: (input: unknown) =>
    Effect.sync(() => {
      console.log(`ECHO_INPUT:${JSON.stringify(input)}`)
      return Draft.empty
    }),
})
