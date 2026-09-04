/**
 * pnpm ops <org> <command> [args] — the OPERATOR's view of any workspace:
 * raw and unfiltered, bypassing every rule, for debugging and cleanup.
 *
 *   info                       generation(s), declaration, version, row counts per entity, apps
 *   schema                     the declaration, verbatim
 *   schema-set <file.json>     replace it (same checks as set_schema)
 *   schema-reset               back to no declared entities
 *   query <entity> [k=v …]     rows, unfiltered (ref fields take an id)
 *   triples [subject]          raw triples, one subject or the first 500
 *   log [since]                the last log entries (or since a version)
 *   users · apps               shortcuts for query user / query app
 *   delete <id …>              delete subjects (one transaction; inbound refs swept)
 *   purge <entity>             delete every row of an entity
 *   delete-app <name>          an app with its whole history
 *   reset --yes                wipe the cell: triples, log, schema. Clients must reconnect.
 *
 * Env: OPS_URL (default http://localhost:8787) · OPS_KEY (default: OPERATOR_KEY in .dev.vars).
 * Production: OPS_URL=https://workspaces.<you>.workers.dev OPS_KEY=<the secret you set>.
 */
import { existsSync, readFileSync } from "node:fs";

const [org, command, ...rest] = process.argv.slice(2);
if (!org || !command) {
  console.error("usage: pnpm ops <org> <command> [args] — see cli.ts for the commands");
  process.exit(2);
}
const url = process.env.OPS_URL ?? "http://localhost:8787";
const key =
  process.env.OPS_KEY ??
  (existsSync(new URL("./.dev.vars", import.meta.url))
    ? /^OPERATOR_KEY=(.+)$/m.exec(readFileSync(new URL("./.dev.vars", import.meta.url), "utf8"))?.[1]?.trim()
    : undefined);
if (!key) {
  console.error("no operator key: set OPS_KEY, or OPERATOR_KEY in packages/worker/.dev.vars");
  process.exit(2);
}

const literal = (raw: string): unknown =>
  raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
const where = (pairs: string[]): Record<string, unknown> =>
  Object.fromEntries(pairs.map((pair) => {
    const eq = pair.indexOf("=");
    return [pair.slice(0, eq), literal(pair.slice(eq + 1))];
  }));

const bodies: Record<string, () => object> = {
  info: () => ({ command: "info" }),
  schema: () => ({ command: "schema" }),
  "schema-set": () => ({ command: "set-schema", declaration: JSON.parse(readFileSync(rest[0]!, "utf8")) }),
  "schema-reset": () => ({ command: "set-schema", declaration: { entities: {} } }),
  query: () => ({ command: "query", entity: rest[0], where: where(rest.slice(1)) }),
  triples: () => ({ command: "triples", subject: rest[0] }),
  log: () => ({ command: "log", since: rest[0] !== undefined ? Number(rest[0]) : undefined }),
  users: () => ({ command: "query", entity: "user" }),
  apps: () => ({ command: "query", entity: "app" }),
  delete: () => ({ command: "delete", ids: rest }),
  purge: () => ({ command: "purge", entity: rest[0] }),
  "delete-app": () => ({ command: "delete-app", name: rest[0] }),
  reset: () => {
    if (!rest.includes("--yes")) {
      console.error(`reset wipes ${org} entirely — triples, log, schema. Add --yes.`);
      process.exit(2);
    }
    return { command: "reset" };
  },
};
const build = bodies[command];
if (!build) {
  console.error(`unknown command "${command}" — one of: ${Object.keys(bodies).join(", ")}`);
  process.exit(2);
}

const response = await fetch(`${url}/w/${org}/ops`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(build()),
});
const result: unknown = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }));
console.log(JSON.stringify(result, null, 2));
process.exit(response.ok ? 0 : 1);
