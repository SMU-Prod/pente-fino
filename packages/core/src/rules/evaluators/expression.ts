import type { EvaluationContext } from "./types.js";

/**
 * The expression language behind `threshold.spec.expr` and
 * `arithmetic.spec.formula` / `spec.expect`.
 *
 * ## Why this exists at all
 *
 * A `rules` row is configuration edited through an admin panel (ADR-06,
 * RF-301), not code reviewed. `eval` or `new Function` over that string
 * would turn every rule edit into a remote-code-execution path into the
 * server - completely out of proportion to what these three rule kinds
 * need. This module is a small, closed interpreter instead: a hand-written
 * tokenizer and recursive-descent parser that only ever produces one of a
 * handful of AST node kinds, and an evaluator that only ever resolves a
 * name through an explicit, fixed lookup table - never through indexing a
 * real JavaScript object with an admin-supplied string. There is no way to
 * reach `__proto__`, `constructor`, or anything else on the prototype
 * chain, because the identifier is never used as a property key at all.
 *
 * ## What it can express
 *
 * Arithmetic over a fixed, closed vocabulary of the invoice's own scalar
 * fields (`total`, the energy tariff/PIS/COFINS/ICMS fields, the water/
 * energy meter readings), plus two aggregate functions over the invoice's
 * own named sections (`sectionTotal`, `sectionCount`) and two comparison
 * helpers (`max`, `min`, needed for RN-003's "the greater of minimum and
 * consumption, never the sum"). Grammar:
 *
 * ```
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := '-' unary | primary
 * primary := NUMBER
 *          | FIELD                                   (see FIELD_NAMES)
 *          | ('sectionTotal' | 'sectionCount') '(' STRING ')'
 *          | ('max' | 'min') '(' expr ',' expr ')'
 *          | '(' expr ')'
 * ```
 *
 * This is deliberately scoped to what §12's RN-001, RN-003, RN-007, RN-010
 * and RN-011 genuinely need, all of which turn out to be "does this
 * invoice's own numbers add up" checks:
 *   - RN-007 (card interest ceiling): a sum/difference of named sections
 *     compared to zero, e.g. `sectionTotal("Juros") + sectionTotal("Mora")
 *     - sectionTotal("Principal")`.
 *   - RN-010 (free withdrawals): `sectionCount("Saques")`.
 *   - RN-003 (availability cost): `max(30, kwh)` against a charged amount.
 *   - RN-001 / RN-011: sums and differences of named section totals.
 *
 * ## What it deliberately cannot express (and why that is fine here)
 *
 * - **Anything about the previous invoice.** That is `delta`'s job (a
 *   separate evaluator kind); keeping this language invoice-internal keeps
 *   its scope to "is this one invoice self-consistent."
 * - **Conditionals or branching.** RN-003's "does not apply below a 27-day
 *   cycle" cannot be written as an `if` inside the expression - there is
 *   no `if`. A rule needing a precondition must express it structurally
 *   (a separate rule, or a gate applied before the engine selects the rule
 *   at all), not inside the formula.
 * - **Filtering a subset of items inside a section by content.** Only a
 *   whole named section can be summed or counted; picking out "the items in
 *   this section whose description looks like X" is `pattern`'s job, and
 *   deliberately not duplicated here.
 * - **Arbitrary property access, user-defined functions, loops, or
 *   recursion.** None of these have any syntax in the grammar at all - not
 *   "forbidden by a check", but literally inexpressible, which is the
 *   actual security property this module exists to guarantee.
 * - **Anything but a number as a final result.** A bare string literal (the
 *   only non-numeric primitive the tokenizer knows about) is only ever
 *   legal as the sole argument to `sectionTotal`/`sectionCount`; it can
 *   never be the expression's own value.
 *
 * ## Missing data vs. a broken rule
 *
 * Two very different situations both involve "the value isn't there", and
 * this module treats them differently on purpose:
 *
 * - An **unknown field or function name** is a defect in the rule itself -
 *   the vocabulary is fixed in this file, so the same rule string is
 *   either valid or invalid on every invoice it will ever run against.
 *   `parseExpression` throws `ExpressionError` immediately, before looking
 *   at any invoice, so a bad rule is caught once rather than silently
 *   producing nothing forever.
 * - A **known field the current invoice happens not to carry** (a telecom
 *   invoice has no `tariffs`, a section a rule expects is simply absent
 *   this cycle) is normal, expected data variation. `evaluateExpression`
 *   returns `undefined` for it, and that `undefined` propagates through
 *   every arithmetic operation rather than coercing to `NaN` or `0`. The
 *   caller (see `threshold.ts` / `arithmetic.ts`) treats `undefined` as
 *   "produce no finding" - never guess an accusation from a gap in the
 *   data. Division by zero is folded into this same "missing" case rather
 *   than produced as `Infinity`, for the same reason: `Infinity > x` would
 *   otherwise satisfy almost any threshold by accident.
 * - A result that is **present but non-finite** (`Infinity`, `-Infinity`,
 *   `NaN` - from a literal so large it overflows a double, or from
 *   arithmetic overflow on fields that were genuinely present) is neither
 *   of the above: not missing, and not a fixed defect independent of the
 *   invoice, but a broken computation on real data. `evaluateExpression`
 *   throws for it, for the same reason division-by-zero is folded into
 *   "missing" above - an unguarded `Infinity` would satisfy almost any
 *   threshold and fire on every invoice forever.
 */

export class ExpressionError extends Error {}

const MAX_SOURCE_LENGTH = 500;
const MAX_DEPTH = 64;

const FIELD_NAMES = [
  "total",
  "icms",
  "pis",
  "cofins",
  "te",
  "tusd",
  "readingsCurrent",
  "readingsPrevious",
  "kwh",
  "m3",
  "days",
] as const;
type FieldName = (typeof FIELD_NAMES)[number];

function isFieldName(name: string): name is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(name);
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "punct"; value: "+" | "-" | "*" | "/" | "(" | ")" | "," };

const PUNCTUATION = new Set(["+", "-", "*", "/", "(", ")", ","]);

function tokenize(source: string): Token[] {
  if (source.length === 0) {
    throw new ExpressionError("empty expression");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ExpressionError(`expression exceeds the ${MAX_SOURCE_LENGTH} character limit`);
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j++;
      const text = source.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        // Catches both a malformed literal ("1.2.3" -> NaN) and one that is
        // syntactically fine but overflows a double ("1" followed by ~310
        // digits -> Infinity) - the latter fits comfortably under
        // MAX_SOURCE_LENGTH, so length alone would not have caught it.
        throw new ExpressionError(`invalid number "${text}"`);
      }
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== '"') {
        value += source[j];
        j++;
      }
      if (j >= source.length) {
        throw new ExpressionError("unterminated string literal");
      }
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++;
      tokens.push({ kind: "ident", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: "punct", value: ch as "+" | "-" | "*" | "/" | "(" | ")" | "," });
      i++;
      continue;
    }

    throw new ExpressionError(`unexpected character "${ch}" at position ${i}`);
  }

  return tokens;
}

export type ExprNode =
  | { type: "num"; value: number }
  | { type: "field"; name: FieldName }
  | { type: "aggregate"; name: "sectionTotal" | "sectionCount"; section: string }
  | { type: "compare2"; name: "max" | "min"; left: ExprNode; right: ExprNode }
  | { type: "negate"; arg: ExprNode }
  | { type: "binary"; op: "+" | "-" | "*" | "/"; left: ExprNode; right: ExprNode };

const AGGREGATE_FUNCTIONS = new Set(["sectionTotal", "sectionCount"]);
const COMPARE_FUNCTIONS = new Set(["max", "min"]);

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  // Written out rather than declared as a TypeScript parameter property
  // (`constructor(private readonly tokens: Token[])`). A parameter property
  // is not erasable-only syntax, so Node's strip-only type stripping — the
  // mechanism every `scripts/*.mjs` here relies on to import a `.ts` source
  // with no build step — refuses the whole module with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. That made this one line enough to
  // make anything transitively importing `@pentefino/core`'s rule
  // evaluators unreachable from a plain `node` script, which is how
  // `scripts/proposals.mjs` found it.
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ExprNode {
    const node = this.parseExpr(0);
    if (this.pos !== this.tokens.length) {
      throw new ExpressionError(`unexpected token after expression (at token ${this.pos})`);
    }
    return node;
  }

  private checkDepth(depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new ExpressionError(`expression nested too deeply (max depth ${MAX_DEPTH})`);
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private take(): Token {
    const token = this.tokens[this.pos];
    if (!token) {
      throw new ExpressionError("unexpected end of expression");
    }
    this.pos++;
    return token;
  }

  private expectPunct(value: "(" | ")" | ","): void {
    const token = this.take();
    if (token.kind !== "punct" || token.value !== value) {
      throw new ExpressionError(`expected "${value}"`);
    }
  }

  private parseExpr(depth: number): ExprNode {
    this.checkDepth(depth);
    let left = this.parseTerm(depth + 1);
    for (;;) {
      const token = this.peek();
      if (token?.kind === "punct" && (token.value === "+" || token.value === "-")) {
        this.take();
        const right = this.parseTerm(depth + 1);
        left = { type: "binary", op: token.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseTerm(depth: number): ExprNode {
    this.checkDepth(depth);
    let left = this.parseUnary(depth + 1);
    for (;;) {
      const token = this.peek();
      if (token?.kind === "punct" && (token.value === "*" || token.value === "/")) {
        this.take();
        const right = this.parseUnary(depth + 1);
        left = { type: "binary", op: token.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(depth: number): ExprNode {
    this.checkDepth(depth);
    const token = this.peek();
    if (token?.kind === "punct" && token.value === "-") {
      this.take();
      return { type: "negate", arg: this.parseUnary(depth + 1) };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): ExprNode {
    this.checkDepth(depth);
    const token = this.take();

    if (token.kind === "number") {
      return { type: "num", value: token.value };
    }

    if (token.kind === "punct" && token.value === "(") {
      const inner = this.parseExpr(depth + 1);
      this.expectPunct(")");
      return inner;
    }

    if (token.kind === "ident") {
      const next = this.peek();
      if (next?.kind === "punct" && next.value === "(") {
        return this.parseCall(token.value, depth);
      }
      if (!isFieldName(token.value)) {
        throw new ExpressionError(`unknown field "${token.value}"`);
      }
      return { type: "field", name: token.value };
    }

    throw new ExpressionError("unexpected token");
  }

  private parseCall(name: string, depth: number): ExprNode {
    this.expectPunct("(");

    if (AGGREGATE_FUNCTIONS.has(name)) {
      const arg = this.take();
      if (arg.kind !== "string") {
        throw new ExpressionError(`${name}() requires a quoted section name`);
      }
      this.expectPunct(")");
      return { type: "aggregate", name: name as "sectionTotal" | "sectionCount", section: arg.value };
    }

    if (COMPARE_FUNCTIONS.has(name)) {
      const left = this.parseExpr(depth + 1);
      this.expectPunct(",");
      const right = this.parseExpr(depth + 1);
      this.expectPunct(")");
      return { type: "compare2", name: name as "max" | "min", left, right };
    }

    throw new ExpressionError(`unknown function "${name}"`);
  }
}

/**
 * Parses `source` into an AST, validating its structure - syntax and
 * vocabulary (field/function names) - without looking at any invoice. This
 * check is invoice-independent by construction, so a syntactically or
 * vocabulary-invalid expression throws the same way every time; see the
 * module doc comment for why that is deliberately loud rather than
 * swallowed.
 */
export function parseExpression(source: string): ExprNode {
  return new Parser(tokenize(source)).parse();
}

function resolveField(name: FieldName, invoice: EvaluationContext["invoice"]): number | undefined {
  switch (name) {
    case "total":
      return invoice.totalCents;
    case "icms":
      return invoice.tariffs?.icms;
    case "pis":
      return invoice.tariffs?.pis;
    case "cofins":
      return invoice.tariffs?.cofins;
    case "te":
      return invoice.tariffs?.teCentsKwh;
    case "tusd":
      return invoice.tariffs?.tusdCentsKwh;
    case "readingsCurrent":
      return invoice.readings?.current;
    case "readingsPrevious":
      return invoice.readings?.previous;
    case "kwh":
      return invoice.readings?.kwh;
    case "m3":
      return invoice.readings?.m3;
    case "days":
      return invoice.readings?.days;
  }
}

/**
 * Sums/counts across every section sharing `name` (the canonical schema
 * does not guarantee section names are unique - a paginated statement can
 * repeat one). Returns `undefined`, not zero, when no section matches at
 * all: a rule referencing a section this invoice simply does not have is
 * "missing data", not "an empty total".
 */
function matchingSections(invoice: EvaluationContext["invoice"], name: string) {
  return invoice.sections.filter((section) => section.name === name);
}

function evaluateAggregate(
  name: "sectionTotal" | "sectionCount",
  section: string,
  invoice: EvaluationContext["invoice"],
): number | undefined {
  const sections = matchingSections(invoice, section);
  if (sections.length === 0) return undefined;
  if (name === "sectionCount") {
    return sections.reduce((count, s) => count + s.items.length, 0);
  }
  return sections.reduce((sum, s) => sum + s.items.reduce((t, item) => t + item.amountCents, 0), 0);
}

/**
 * Evaluates a parsed expression against one invoice. See the module doc
 * comment for the "missing field -> undefined -> no finding" contract:
 * `undefined` propagates through every arithmetic operation instead of
 * coercing to `NaN`, and division by zero is treated as missing data
 * rather than `Infinity`.
 */
export function evaluateNode(node: ExprNode, ctx: EvaluationContext): number | undefined {
  switch (node.type) {
    case "num":
      return node.value;
    case "field":
      return resolveField(node.name, ctx.invoice);
    case "aggregate":
      return evaluateAggregate(node.name, node.section, ctx.invoice);
    case "compare2": {
      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);
      if (left === undefined || right === undefined) return undefined;
      return node.name === "max" ? Math.max(left, right) : Math.min(left, right);
    }
    case "negate": {
      const value = evaluateNode(node.arg, ctx);
      return value === undefined ? undefined : -value;
    }
    case "binary": {
      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);
      if (left === undefined || right === undefined) return undefined;
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right === 0 ? undefined : left / right;
      }
    }
  }
}

/** Parses and evaluates `source` against `ctx` in one call. */
export function evaluateExpression(source: string, ctx: EvaluationContext): number | undefined {
  const result = evaluateNode(parseExpression(source), ctx);
  if (result !== undefined && !Number.isFinite(result)) {
    // `undefined` (missing data) is left alone - that is the normal
    // "produce no finding" signal. A *defined* non-finite result (Infinity,
    // -Infinity or NaN) can only come from arithmetic overflow on data that
    // genuinely was present (e.g. multiplying two large-but-finite fields),
    // and is not safe to compare: `Infinity > x` would satisfy almost any
    // threshold and fire on every invoice forever, for no reason any user
    // action caused. Treated as loudly as an unknown field, not silently
    // as missing data.
    throw new ExpressionError(`expression evaluated to a non-finite result (${result})`);
  }
  return result;
}
