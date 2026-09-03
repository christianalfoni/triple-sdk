/**
 * A WORKSPACE = the fixed entities every workspace has (its people, its apps)
 * plus whatever it declared — as one schema and one policy the cell runs.
 * The fixed part is code; the declared part is data (§4.9), and this module
 * is where the two meet: build, validate, evolve, and serve to a browser.
 */
import {
  Schema,
  declarationOf,
  entitiesFromDeclaration,
  type AppSchema,
  type Entities,
  type EntityDeclaration,
  type EntityDef,
  type FieldDeclaration,
} from "triple-sdk/schema";
import { definePolicy, type Policy } from "triple-sdk/server/policy";
import type { Readable } from "triple-sdk/types";
import { platformPolicies } from "./policy.ts";
import { compileRules, type EntityRules } from "./rules.ts";
import type { PlatformEntities, PlatformUserFields } from "./schema.ts";

export type WorkspaceEntityDeclaration = EntityDeclaration & { rules?: EntityRules };
export type WorkspaceDeclaration = { entities: Record<string, WorkspaceEntityDeclaration> };

export const EMPTY_DECLARATION: WorkspaceDeclaration = { entities: {} };

export type Workspace = {
  schema: AppSchema;
  policy: Policy;
  /** The declared entities alone, built — for a client that wants typed handles. */
  declared: Entities;
  declaration: WorkspaceDeclaration;
};

/**
 * The fixed rule for people: members see every member, an app user sees only
 * themselves; only you write your row; `role` is written by the cell from the
 * edge's verified headers and by nobody else (or an app user promotes
 * themselves).
 */
export function userPolicy<U extends EntityDef & PlatformUserFields>(User: U) {
  const Policy = definePolicy({ actor: User });
  const isMember = (actor: { id: string; role?: string | undefined }): boolean =>
    actor.role === "admin" || actor.role === "member";
  return Policy.from(User, {
    read: (ctx) => ctx.subject === ctx.actor.id || isMember(ctx.actor),
    create: (ctx) => ctx.subject === ctx.actor.id,
    update: (ctx) => ctx.subject === ctx.actor.id,
    delete: (ctx) => ctx.subject === ctx.actor.id,
    overrides: { role: { write: () => false } },
  });
}

/** Build the workspace: throws with a precise message on any problem in the declaration. */
export function buildWorkspace<U extends EntityDef & PlatformUserFields>(options: {
  User: U;
  platform: PlatformEntities<U>;
  declaration: WorkspaceDeclaration;
}): Workspace {
  const { User, platform, declaration } = options;
  const fixed: Entities = { user: User, ...platform };
  const shapes = Object.fromEntries(
    Object.entries(declaration.entities).map(([name, entity]) => [name, { fields: entity.fields }]),
  );
  const declared = entitiesFromDeclaration({ entities: shapes }, fixed);
  const schema = Schema.build({ ...fixed, ...declared });
  const Policy = definePolicy({ actor: User });
  const policies: Record<string, unknown> = {
    user: userPolicy(User),
    ...platformPolicies(User, platform),
  };
  for (const [name, entity] of Object.entries(declared)) {
    policies[name] = compileRules(name, entity, declaration.entities[name]?.rules ?? {}, Policy);
  }
  const policy = Policy.build(schema, policies as never);
  return { schema, policy, declared, declaration };
}

/** Structural validation of an incoming declaration — shape only; `buildWorkspace` finds the rest. */
export function validateDeclaration(input: unknown): WorkspaceDeclaration {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error('A declaration is an object: { "entities": { "<name>": { "fields": { … }, "rules": { … } } } }.');
  }
  const entities = (input as { entities?: unknown }).entities;
  if (typeof entities !== "object" || entities === null || Array.isArray(entities)) {
    throw new Error('A declaration needs "entities": an object keyed by entity name.');
  }
  for (const [name, entity] of Object.entries(entities as Record<string, unknown>)) {
    if (typeof entity !== "object" || entity === null) throw new Error(`Entity "${name}": expected an object.`);
    const { fields, rules, ...rest } = entity as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      throw new Error(`Entity "${name}": unknown keys ${Object.keys(rest).join(", ")} — an entity has "fields" and "rules".`);
    }
    if (typeof fields !== "object" || fields === null) throw new Error(`Entity "${name}": needs "fields".`);
    if (rules !== undefined) {
      if (typeof rules !== "object" || rules === null) throw new Error(`Entity "${name}": "rules" must be an object.`);
      for (const key of Object.keys(rules)) {
        if (!["read", "create", "update", "delete", "overrides"].includes(key)) {
          throw new Error(`Entity "${name}": rules.${key} is not a verb — read, create, update, delete, overrides.`);
        }
      }
    }
  }
  return input as WorkspaceDeclaration;
}

/**
 * Accrete, never break (§4.5, §7.3): what a new declaration may not do to
 * entities that already hold rows. Removing fields or entities is fine (the
 * data goes dark, nothing corrupts); loosening required → optional is fine.
 */
export function migrationProblems(
  previous: WorkspaceDeclaration,
  next: WorkspaceDeclaration,
  storage: Readable,
): string[] {
  const problems: string[] = [];
  for (const [name, entity] of Object.entries(next.entities)) {
    const before = previous.entities[name];
    if (!before) continue;
    const hasRows = Object.keys(before.fields).some(
      (field) => storage.match([undefined, `${name}/${field}`, undefined]).length > 0,
    );
    for (const [field, spec] of Object.entries(entity.fields)) {
      const was = before.fields[field];
      if (was === undefined) {
        if (hasRows && isRequired(spec)) {
          problems.push(
            `${name}.${field}: adding a REQUIRED field to an entity that already has rows would leave them incomplete — declare it optional, or backfill under a new name first.`,
          );
        }
        continue;
      }
      const from = canonical(was);
      const to = canonical(spec);
      const loosened = { ...to, optional: from.optional };
      if (JSON.stringify(from) !== JSON.stringify(to) && !(to.optional && JSON.stringify(from) === JSON.stringify(loosened))) {
        problems.push(`${name}.${field}: changing a field's type or cardinality is not supported — add a new field and migrate.`);
      }
    }
  }
  return problems;
}

function isRequired(spec: FieldDeclaration): boolean {
  if (typeof spec === "string") return true;
  return !("multiple" in spec && spec.multiple) && !spec.optional;
}

function canonical(spec: FieldDeclaration): Record<string, unknown> {
  if (typeof spec === "string") return { type: spec, multiple: false, optional: false };
  const multiple = "multiple" in spec ? Boolean(spec.multiple) : false;
  const optional = Boolean(spec.optional);
  if ("ref" in spec) return { ref: spec.ref, multiple, optional };
  if ("oneOf" in spec) return { oneOf: [...spec.oneOf], multiple, optional };
  if ("object" in spec) return { object: JSON.stringify(spec.object), multiple, optional };
  return { type: spec.type, multiple, optional };
}

/**
 * The schema as a browser module: `import { schema, Note, User } from "schema"`.
 * Every entity, fixed and declared, as data — rebuilt in the browser with the
 * very same builders, so the hash the client presents is the cell's own.
 */
export function schemaModule(schema: AppSchema): string {
  const declaration = declarationOf(schema.entities);
  const exports = Object.keys(schema.entities)
    .map((name) => `export const ${name[0]!.toUpperCase()}${name.slice(1)} = entities[${JSON.stringify(name)}];`)
    .join("\n");
  return [
    "// Generated by the workspace cell: this workspace's schema, as data (§4.9).",
    'import { Schema, entitiesFromDeclaration } from "triple-sdk/schema";',
    `export const declaration = ${JSON.stringify(declaration)};`,
    "export const entities = entitiesFromDeclaration(declaration);",
    "export const schema = Schema.build(entities);",
    exports,
    "export default entities;",
    "",
  ].join("\n");
}
