import { Schema, type EntityDef } from "triple-sdk/schema";
import { TripleServer } from "triple-sdk/server";
import { definePolicy } from "triple-sdk/server/policy";
import { MemoryStorage } from "triple-sdk/storage";
import { Query, toPayload } from "triple-sdk/query";
import { platformEntities, platformUserFields } from "./src/schema.ts";
import { platformPolicies } from "./src/policy.ts";
import { buildWorkspace, userPolicy } from "./src/workspace.ts";
import { compileRules, evaluate } from "./src/rules.ts";

const User = Schema.from({ name: Schema.string(), ...platformUserFields });
const platform = platformEntities(User);
const todoFields = { text: "string", completed: "boolean", shared: "boolean", owner: { ref: "user" } } as const;
const mine = { equals: ["fields.owner", "actor"] } as const;
const board = { allOf: [{ equals: ["fields.shared", true] }, { in: ["actor.role", ["admin", "member"]] }] } as const;
const rules = { read: { anyOf: [mine, board] }, create: mine, update: mine, delete: mine } as const;

// A — declared: rules as data, compiled by the platform
const declared = buildWorkspace({ User, platform, declaration: { entities: { todo: { fields: todoFields, rules } } } });

// B — code: the same rules as lambdas, the same fields declared by hand
const TodoCode = Schema.from({ text: Schema.string(), completed: Schema.boolean(), shared: Schema.boolean(), owner: Schema.ref(User) });
const codeSchema = Schema.build({ user: User, ...platform, todo: TodoCode });
const Policy = definePolicy({ actor: User });
const isMember = (a: { role?: string }) => a.role === "admin" || a.role === "member";
const codePolicy = Policy.build(codeSchema, {
  user: userPolicy(User), ...platformPolicies(User, platform),
  todo: Policy.from(TodoCode, {
    fields: { owner: true, shared: true },
    read: (ctx) => ctx.fields.owner?.id === ctx.actor.id || (ctx.fields.shared === true && isMember(ctx.actor)),
    create: (ctx) => ctx.fields.owner?.id === ctx.actor.id, update: (ctx) => ctx.fields.owner?.id === ctx.actor.id, delete: (ctx) => ctx.fields.owner?.id === ctx.actor.id,
  }),
} as never);

function seeded(schema: typeof codeSchema, policy: typeof codePolicy, Todo: EntityDef, n: number) {
  const server = new TripleServer({ schema, policy, storage: new MemoryStorage() });
  const tx = server.transaction();
  tx.edit(User, "user_a").name = "A"; (tx.edit(User, "user_a") as { role: string }).role = "member";
  tx.edit(User, "user_b").name = "B"; (tx.edit(User, "user_b") as { role: string }).role = "member";
  for (let i = 0; i < n; i++) {
    tx.create(Todo, { text: `t${i}`, completed: false, shared: i % 2 === 0, owner: { id: i % 3 === 0 ? "user_a" : "user_b" } } as never);
  }
  server.commit(tx);
  return server;
}
const N = 20_000;
const A = seeded(declared.schema as never, declared.policy as never, declared.declared.todo!, N);
const B = seeded(codeSchema, codePolicy, TodoCode, N);
const query = (Todo: EntityDef) => toPayload(Query.from(Todo).where("shared", true).select({ text: true } as never));
const time = (label: string, run: () => number) => {
  run(); // warm
  const t = performance.now(); let out = 0;
  for (let i = 0; i < 5; i++) out = run();
  console.log(`${label.padEnd(44)} ${((performance.now() - t) / 5).toFixed(1).padStart(6)} ms   (${out} triples)`);
};
time("query 10k shared candidates — lambdas", () => B.query({ kind: "query", schema: B.schemaHash, payload: query(TodoCode) }, "user_a").triples.length);
time("query 10k shared candidates — declared rules", () => A.query({ kind: "query", schema: A.schemaHash, payload: query(declared.declared.todo!) }, "user_a").triples.length);

// the rule alone, 1M evaluations
const ctx = { actor: { id: "user_a", role: "member" }, subject: "todo_1", fields: { owner: { id: "user_b" }, shared: true } };
const lambda = (c: typeof ctx) => c.fields.owner?.id === c.actor.id || (c.fields.shared === true && isMember(c.actor));
const compiled = compileRules("todo", declared.declared.todo!, rules as never, Policy as never).read as unknown as (c: typeof ctx) => boolean;
for (const [label, fn] of [["rule ×1M — lambda", lambda], ["rule ×1M — declared (interpreted)", compiled], ["rule ×1M — evaluate() raw", (c: typeof ctx) => evaluate(rules.read as never, c as never) === true]] as const) {
  let hits = 0; const t = performance.now();
  for (let i = 0; i < 1_000_000; i++) if (fn(ctx)) hits++;
  console.log(`${label.padEnd(44)} ${(performance.now() - t).toFixed(0).padStart(6)} ms   (${hits} true)`);
}
