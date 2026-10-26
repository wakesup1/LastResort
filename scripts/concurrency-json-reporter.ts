import { JsonReporter } from "vitest/node";

// Vitest 5 otherwise writes raw failure details to .vitest/json/output.json.
// Keep them in the parent's pipe; only whitelisted counts become retained evidence.
export default class ConcurrencyJsonReporter extends JsonReporter {
  constructor() { super({ stdout: true }); }
}
