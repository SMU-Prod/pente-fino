// Task 2 (delta, reference, confirm) and Task 1 (pattern, threshold,
// arithmetic) each add their own evaluators to this barrel independently -
// a merge conflict here, combining both sets of exports, is expected and
// trivial to resolve.
export type { Evaluator, EvaluationContext, References } from "./types.js";
export { delta } from "./delta.js";
export { reference } from "./reference.js";
export { confirm, confirmAnswerKey } from "./confirm.js";
