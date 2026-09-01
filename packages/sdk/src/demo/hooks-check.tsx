/**
 * `useQuery` lifecycle proof, on REAL React + real DOM (happy-dom):
 *   1. first paint is cache-first (rows visible before any effect ran),
 *   2. a transact re-renders through the hook,
 *   3. unmount closes the watch — and the cache EVICTS what nothing watches.
 * StrictMode is ON, so mount/effect double-invocation is exercised too.
 */
import { Window } from "happy-dom";

const window = new Window();
Object.assign(globalThis, { window, document: window.document });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { StrictMode } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { MemoryStorage } = await import("../sdk/shared/storage.ts");
const { TripleServer } = await import("../sdk/server/server.ts");
const { TripleClient } = await import("../sdk/client/client.ts");
const { createHooks } = await import("../sdk/client/react.ts");
const { Query } = await import("../sdk/shared/query.ts");
const { Transaction } = await import("../sdk/shared/transaction.ts");
const { schema, Todo, User, DEMO_USER } = await import("./shared/schema.ts");
const { policy } = await import("./server/policy.ts");
type Transport = import("../sdk/client/transport.ts").Transport;

const server = new TripleServer({ schema, policy, storage: new MemoryStorage() });
const seed = new Transaction(server.schema, server.storage);
seed.edit(User, DEMO_USER).name = "Christian";
seed.edit(Todo, "todo_h1").text = "hook it up";
seed.edit(Todo, "todo_h1").completed = false;
seed.edit(Todo, "todo_h1").owner = { id: DEMO_USER };
seed.edit(Todo, "todo_h2").text = "already done";
seed.edit(Todo, "todo_h2").completed = true;
seed.edit(Todo, "todo_h2").owner = { id: DEMO_USER };
server.commit(seed);

const transport: Transport = {
  query: async (message) => server.query(message, DEMO_USER),
  transact: async (message) => server.transact(message, DEMO_USER),
  broadcast: async () => {},
  deltas: (getSince, onMessage) =>
    server.subscribe(DEMO_USER, onMessage, getSince() > 0 ? getSince() : undefined),
};
const client = new TripleClient({ schema, transport });
client.connect();
const { useQuery } = createHooks(client);

const mine = Query.from(Todo)
  .where("owner", { id: DEMO_USER })
  .orderBy("text")
  .select({ text: true });

function List() {
  const todos = useQuery(mine);
  return (
    <ul>
      {todos.data.map((todo) => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  );
}

const fail = (message: string): never => {
  console.error(`  hooks: ${message}`);
  process.exit(1);
};
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

// warm the cache the way a persisted client would be warm
const warm = client.watch(mine);
await warm.ready;
warm.close();
// (closing evicted — re-warm through a throwaway watch kept open for step 1)
const keeper = client.watch(mine);
await keeper.ready;

const container = window.document.createElement("div");
window.document.body.appendChild(container);
const root = createRoot(container as never);

// 1 — first paint from cache, synchronously
await act(async () => root.render(<StrictMode><List /></StrictMode>));
if (!container.textContent?.includes("hook it up")) fail("first paint missed cached row");
keeper.close(); // the hook's own watch holds the cache from here

// 2 — a write re-renders through the hook
await act(async () => { await client.transact((tx) => (tx.edit(Todo, "todo_h1").text = "hooked!")); });
await settle();
if (!container.textContent?.includes("hooked!")) fail("update did not re-render");

// 3 — DYNAMIC queries: the callback form, deps deciding when it is a NEW query
// — React's own memoization rule. Deps fire → old watch closes (and evicts),
// new one loads.
function ByCompletion({ completed }: { completed: boolean }) {
  const todos = useQuery(
    () =>
      Query.from(Todo)
        .where("owner", { id: DEMO_USER })
        .where("completed", completed)
        .orderBy("text")
        .select({ text: true }),
    [completed],
  );
  return (
    <ul>
      {todos.data.map((todo) => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  );
}
await act(async () => root.render(<StrictMode><ByCompletion completed={false} /></StrictMode>));
await settle();
if (!container.textContent?.includes("hooked!")) fail("dynamic query missed incomplete row");
await act(async () => root.render(<StrictMode><ByCompletion completed={true} /></StrictMode>));
await settle();
if (!container.textContent?.includes("already done")) fail("prop change did not re-key the query");
if (container.textContent?.includes("hooked!")) fail("old query's rows survived the re-key");

// 4 — unmount closes the watch; eviction drops what nothing watches
const before = client.size;
await act(async () => root.unmount());
await settle();
if (client.size >= before) fail(`unmount did not evict (size ${before} → ${client.size})`);

console.log(
  `  hooks   cache-first paint ✓ · live re-render ✓ · callback form re-keys on deps change ✓ · unmount evicts ${before} → ${client.size} triples ✓`,
);
process.exit(0);
