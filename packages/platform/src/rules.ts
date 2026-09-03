/**
 * The rule language — access rules as DATA, for entities that arrive as data.
 *
 * The SDK's own policies are lambdas, and only lambdas (SPEC §10.7: two rule
 * languages side by side was built, measured and removed). A workspace whose
 * schema is declared over a wire cannot ship lambdas into a cell, so the
 * platform speaks rules as JSON expressions and COMPILES them to lambdas at
 * load — the SDK still sees exactly one kind of rule. Being declarative-only
 * here buys what §10.7 said it would: the `fields` a rule needs derive
 * themselves from the paths it mentions, so the visibility dependency map is
 * static, and a rule can print itself for an agent to read.
 *
 *   { "equals": ["fields.owner", "actor"] }
 *   { "anyOf": [ { "equals": ["fields.shared", true] }, { "in": ["actor.role", ["admin", "member"]] } ] }
 *
 * Operands are literals (true, 3, "admin") or PATHS — strings that start with
 * `actor`, `subject`, `fields` or `after`. A ref compares by id; a list
 * operand means "any element". Every verb is denied unless its rule says
 * true, and an actor with no row reads as nothing — so rules are positive.
 */
import { refTarget, type EntityDef } from "triple-sdk/schema";
import type { definePolicy, EntityPolicyFor } from "triple-sdk/server/policy";

export type Rule =
  | boolean
  | number
  | string
  | null
  | { literal: string | number | boolean | null }
  | { equals: readonly [Rule, Rule] }
  | { in: readonly [Rule, Rule | readonly Rule[]] }
  | { anyOf: readonly Rule[] }
  | { allOf: readonly Rule[] }
  | { not: Rule };

export type EntityRules = {
  read?: Rule;
  create?: Rule;
  update?: Rule;
  delete?: Rule;
  overrides?: Record<string, { read?: Rule; write?: Rule }>;
};

export const RULE_LANGUAGE = [
  "Rules are JSON expressions, evaluated per row for the caller; a verb without a rule is denied.",
  '  { "equals": [a, b] }   { "in": [needle, list] }   { "anyOf": [ … ] }   { "allOf": [ … ] }   { "not": e }',
  "Operands: literals (true, 3, \"admin\", or { \"literal\": \"…\" }) or paths:",
  '  "actor" (the caller\'s id) · "actor.role" · "actor.email" · "subject" (the row\'s id)',
  '  "fields.<field>" (the row) · "fields.<ref>.<field>" (through a ref) · "after.<field>" (the row as it will be — update)',
  "A ref compares by id; a multiple field is a list, and `in` tests membership. Rules are positive:",
  "an actor with no row has no role, and undefined denies.",
  "Verbs: read · create (fields = the row as it lands) · update (fields = before, after = after) · delete.",
  '"overrides": { "<field>": { "read": e, "write": e } } replaces the entity rule for that field alone.',
].join("\n");

type BoundPolicy = ReturnType<typeof definePolicy>;
type Ctx = {
  actor: { id: string } & Record<string, unknown>;
  subject: string;
  fields: Record<string, unknown>;
  after?: Record<string, unknown>;
};
type Selection = { [field: string]: true | Selection };

const PATH = /^(actor|subject|fields|after)(\.[a-z][a-zA-Z0-9]*)*$/;
const isPath = (value: unknown): value is string => typeof value === "string" && PATH.test(value);

/** Compile one entity's rules into the SDK's policy form, deriving `fields` from the paths. */
export function compileRules(
  name: string,
  entity: EntityDef,
  rules: EntityRules,
  Policy: BoundPolicy,
): EntityPolicyFor<EntityDef> {
  const selection: Selection = {};
  const seen = new Set<string>();
  const declare = (path: string): void => {
    const [head, ...rest] = path.split(".");
    if (head === "actor") {
      if (rest.length > 1) throw new Error(`${name} rules: "${path}" — actor paths are one level deep.`);
      return;
    }
    if (head === "subject") {
      if (rest.length > 0) throw new Error(`${name} rules: "${path}" — subject is the row's id, it has no fields.`);
      return;
    }
    if (rest.length === 0) throw new Error(`${name} rules: "${path}" names no field.`);
    let current: Selection = selection;
    let target: EntityDef = entity;
    let where = name;
    for (let i = 0; i < rest.length; i++) {
      const field = rest[i]!;
      const builder = target[field];
      if (!builder) throw new Error(`${name} rules: "${path}" — ${where} has no field "${field}".`);
      if (i === rest.length - 1) {
        if (current[field] === undefined) current[field] = true;
        break;
      }
      const next = refTarget(builder);
      if (!next) throw new Error(`${name} rules: "${path}" — ${where}.${field} is not a ref, it cannot be traversed.`);
      const existing = current[field];
      const nested: Selection = existing !== undefined && existing !== true ? existing : {};
      current[field] = nested;
      current = nested;
      target = next;
      where = `${where}.${field}`;
    }
  };
  const walk = (rule: Rule | undefined): void => {
    if (rule === undefined || rule === null || typeof rule !== "object") {
      if (isPath(rule) && !seen.has(rule)) {
        seen.add(rule);
        declare(rule);
      }
      return;
    }
    if ("literal" in rule) return;
    if ("equals" in rule) return rule.equals.forEach(walk);
    if ("in" in rule) {
      walk(rule.in[0]);
      const list = rule.in[1];
      return Array.isArray(list) ? list.forEach(walk) : walk(list as Rule);
    }
    if ("anyOf" in rule) return rule.anyOf.forEach(walk);
    if ("allOf" in rule) return rule.allOf.forEach(walk);
    if ("not" in rule) return walk(rule.not);
    throw new Error(`${name} rules: ${JSON.stringify(rule)} is not a rule — use equals, in, anyOf, allOf, not.`);
  };
  for (const verb of ["read", "create", "update", "delete"] as const) walk(rules[verb]);
  for (const [field, override] of Object.entries(rules.overrides ?? {})) {
    if (!entity[field]) throw new Error(`${name} rules: overrides name "${field}", which is not a field.`);
    walk(override.read);
    walk(override.write);
  }

  const compile = (rule: Rule | undefined) => {
    if (rule === undefined) return () => false;
    const run = compileExpression(rule);
    return (ctx: Ctx) => run(ctx) === true;
  };
  const overrides: Record<string, { read?: (ctx: Ctx) => boolean; write?: (ctx: Ctx) => boolean }> = {};
  for (const [field, override] of Object.entries(rules.overrides ?? {})) {
    overrides[field] = {
      ...(override.read !== undefined ? { read: compile(override.read) } : {}),
      ...(override.write !== undefined ? { write: compile(override.write) } : {}),
    };
  }
  return Policy.from(entity, {
    fields: selection as never,
    read: compile(rules.read) as never,
    create: compile(rules.create) as never,
    update: compile(rules.update) as never,
    delete: compile(rules.delete) as never,
    overrides: overrides as never,
  });
}

type Compiled = (ctx: Ctx) => unknown;

/**
 * Compile a rule into closures ONCE: paths are split ahead of time, every
 * operator becomes a direct call. Measured: interpreting the JSON per call
 * cost ~300ns against ~4ns for the lambda it stands for; compiled closures
 * bring the policy-dominated query path back within a few percent of code.
 */
export function compileExpression(rule: Rule): Compiled {
  if (rule === null || typeof rule !== "object") {
    if (!isPath(rule)) return () => rule;
    const [head, ...rest] = rule.split(".");
    if (head === "actor") {
      const key = rest[0];
      return key === undefined ? (ctx) => ctx.actor.id : (ctx) => ctx.actor[key];
    }
    if (head === "subject") return (ctx) => ctx.subject;
    if (head === "after") return (ctx) => walkValue(ctx.after ?? ctx.fields, rest);
    if (rest.length === 1) {
      const key = rest[0]!;
      return (ctx) => ctx.fields[key]; // the common shape: one field of the row
    }
    return (ctx) => walkValue(ctx.fields, rest);
  }
  if ("literal" in rule) {
    const value = rule.literal;
    return () => value;
  }
  if ("equals" in rule) {
    const [a, b] = [compileExpression(rule.equals[0]), compileExpression(rule.equals[1])];
    return (ctx) => same(a(ctx), b(ctx));
  }
  if ("in" in rule) {
    const needle = compileExpression(rule.in[0]);
    const list = rule.in[1];
    if (Array.isArray(list) && list.every((item) => item === null || typeof item !== "object")) {
      // A literal list ("admin", "member"): one Set, built once.
      const literals = new Set(list.map((item) => (isPath(item) ? undefined : item)));
      const paths = list.filter(isPath).map(compileExpression);
      return (ctx) => {
        const wanted = normalize(needle(ctx));
        if (literals.has(wanted as never)) return true;
        return paths.some((path) => same(path(ctx), wanted));
      };
    }
    const values: Compiled = Array.isArray(list)
      ? ((items) => (ctx: Ctx) => items.map((item) => item(ctx)))(list.map((item) => compileExpression(item as Rule)))
      : compileExpression(list as Rule);
    return (ctx) => {
      const haystack = normalize(values(ctx));
      if (!Array.isArray(haystack)) return false;
      const wanted = normalize(needle(ctx));
      return haystack.some((value) => same(value, wanted));
    };
  }
  if ("anyOf" in rule) {
    const branches = rule.anyOf.map(compileExpression);
    return (ctx) => branches.some((branch) => branch(ctx) === true);
  }
  if ("allOf" in rule) {
    const branches = rule.allOf.map(compileExpression);
    return (ctx) => branches.every((branch) => branch(ctx) === true);
  }
  if ("not" in rule) {
    const inner = compileExpression(rule.not);
    return (ctx) => inner(ctx) !== true;
  }
  return () => false;
}

/** Evaluate a rule once — compiles and runs; hot paths hold the compiled form instead. */
export function evaluate(rule: Rule, ctx: Ctx): unknown {
  return compileExpression(rule)(ctx);
}

function walkValue(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => walkValue(item, segments));
  if (value !== null && typeof value === "object") {
    let current: unknown = value;
    for (let i = 0; i < segments.length; i++) {
      if (Array.isArray(current)) return current.map((item) => walkValue(item, segments.slice(i)));
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segments[i]!];
    }
    return current;
  }
  return undefined;
}

/** Refs (anything with an id) become their id; lists normalize elementwise. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object" && "id" in value) return (value as { id: unknown }).id;
  return value;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (Array.isArray(na) || Array.isArray(nb)) return JSON.stringify(na) === JSON.stringify(nb);
  return false;
}
