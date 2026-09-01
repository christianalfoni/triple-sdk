/**
 * Same-harness comparison: the node demo server vs the Durable Object cell,
 * both over localhost HTTP — the first apples-to-apples numbers in this repo.
 *   BENCH_API=http://localhost:8787/w/bench-1/api npx tsx src/demo/dobench.ts
 */
import { performance } from "node:perf_hooks";
import { Query, toPayload } from "../sdk/shared/query.ts";
import { schema, DEMO_USER, Todo } from "./shared/schema.ts";

const api = process.env.BENCH_API ?? "http://localhost:3000/api";
const TODOS = 20_000;

async function post(route: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${api}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

const transact = (mutationId: string, operations: unknown[]) =>
  post("transact", { kind: "transact", schema: schema.hash, mutationId, operations });

async function seedHeavy(): Promise<void> {
  await transact("seed-user", [
    { op: "set", subject: DEMO_USER, predicate: "user/name", value: "Bench" },
  ]);
  const batch = 250;
  for (let start = 0; start < TODOS; start += batch) {
    const operations: unknown[] = [];
    for (let i = start; i < start + batch; i++) {
      const id = `todo_b${i}`;
      operations.push(
        { op: "set", subject: id, predicate: "todo/text", value: `task ${String(i).padStart(5, "0")}` },
        { op: "set", subject: id, predicate: "todo/completed", value: i % 2 === 0 },
        { op: "set", subject: id, predicate: "todo/owner", value: { id: DEMO_USER } },
      );
    }
    await transact(`seed-${start}`, operations);
  }
}

async function timed(label: string, runs: number, fn: () => Promise<unknown>): Promise<void> {
  await fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  console.log(`  ${label.padEnd(44)} ${((performance.now() - t0) / runs).toFixed(1).padStart(6)}ms`);
}

const q = (payload: unknown) => post("query", { kind: "query", schema: schema.hash, payload });

async function fanout(subscribers: number): Promise<void> {
  const controllers: AbortController[] = [];
  const arrivals: Promise<number>[] = [];
  for (let i = 0; i < subscribers; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${api}/subscribe`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    const reader = response.body!.getReader();
    arrivals.push(
      (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return performance.now();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes("fanout-probe")) return performance.now();
        }
      })(),
    );
  }
  const t0 = performance.now();
  await transact("fanout", [
    { op: "set", subject: "todo_b7", predicate: "todo/text", value: "fanout-probe" },
  ]);
  const times = await Promise.all(arrivals);
  const last = Math.max(...times) - t0;
  console.log(`  write → ${subscribers} live subscribers (last arrival)  ${last.toFixed(1).padStart(6)}ms`);
  for (const controller of controllers) controller.abort();
}

console.log(`target: ${api}`);
const t0 = performance.now();
await seedHeavy();
console.log(`  seed ${TODOS} todos (${TODOS / 250} transacts)          ${(performance.now() - t0).toFixed(0).padStart(6)}ms`);
await timed("whereId (1 of 20k)", 20, () =>
  q(toPayload(Query.from(Todo).whereId("todo_b7").select({ text: true }) as never)));
await timed("ordered window, 50 of 20k", 20, () =>
  q(toPayload(Query.from(Todo).where("owner", { id: DEMO_USER }).orderBy("text").limit(50).select({ text: true }) as never)));
await timed("1k rows, policy-filtered", 10, () =>
  q(toPayload(Query.from(Todo).where("owner", { id: DEMO_USER }).whereGreater("text", "task 19000").select({ text: true, completed: true }) as never)));
await timed("write round-trip (3 triples, ack)", 20, () =>
  transact(`w${Math.random()}`, [
    { op: "set", subject: "todo_b9", predicate: "todo/text", value: `t${Math.random()}` },
  ]));
await fanout(100);
process.exit(0);
