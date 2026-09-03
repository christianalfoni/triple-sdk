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

  const compile = (rule: Rule | undefined) =>
    rule === undefined ? () => false : (ctx: Ctx) => evaluate(rule, ctx) === true;
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

/** Evaluate a rule against a policy context. Paths resolve through the materialized fields. */
export function evaluate(rule: Rule, ctx: Ctx): unknown {
  if (rule === null || typeof rule !== "object") {
    return isPath(rule) ? lookup(rule, ctx) : rule;
  }
  if ("literal" in rule) return rule.literal;
  if ("equals" in rule) return same(evaluate(rule.equals[0], ctx), evaluate(rule.equals[1], ctx));
  if ("in" in rule) {
    const needle = normalize(evaluate(rule.in[0], ctx));
    const list = rule.in[1];
    const values = Array.isArray(list) ? list.map((item) => evaluate(item as Rule, ctx)) : evaluate(list as Rule, ctx);
    const normalized = normalize(values);
    return Array.isArray(normalized) && normalized.some((value) => same(value, needle));
  }
  if ("anyOf" in rule) return rule.anyOf.some((branch) => evaluate(branch, ctx) === true);
  if ("allOf" in rule) return rule.allOf.every((branch) => evaluate(branch, ctx) === true);
  if ("not" in rule) return evaluate(rule.not, ctx) !== true;
  return false;
}

function lookup(path: string, ctx: Ctx): unknown {
  const [head, ...rest] = path.split(".");
  if (head === "actor") return rest.length === 0 ? ctx.actor.id : ctx.actor[rest[0]!];
  if (head === "subject") return ctx.subject;
  const root = head === "after" ? (ctx.after ?? ctx.fields) : ctx.fields;
  return walkValue(root, rest);
}

function walkValue(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => walkValue(item, segments));
  if (value !== null && typeof value === "object") {
    return walkValue((value as Record<string, unknown>)[segments[0]!], segments.slice(1));
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
  const na = normalize(a);
  const nb = normalize(b);
  if (Array.isArray(na) || Array.isArray(nb)) return JSON.stringify(na) === JSON.stringify(nb);
  return na === nb;
}
