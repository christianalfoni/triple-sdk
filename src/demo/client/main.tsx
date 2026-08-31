import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HttpTransport, TripleClient } from "../../sdk/client/index.ts";
import { createHooks } from "../../sdk/client/react.ts";
import { Query, type ResultOf } from "../../sdk/shared/query.ts";
import { isRef } from "../../sdk/shared/value.ts";
import type { Triple } from "../../sdk/shared/types.ts";
import { DEMO_TEAM, DEMO_USER, schema, Todo } from "../shared/schema.ts";

// The client holds two layers, never merged: CONFIRMED (only what the server
// said) + PENDING (optimistic previews). Reads see both; an ack or reject just
// drops a layer — no undo code exists anywhere. `persistence` makes cache, cursor
// and write-queue survive reloads (~345KB per 10k triples): cold boots render
// from disk before the network answers.
const client = new TripleClient({
  schema,
  transport: new HttpTransport("/api"),
  persistence: {
    load: () => localStorage.getItem("rdf-demo"),
    save: (state) => localStorage.setItem("rdf-demo", state),
  },
});

client.connect(); // SSE push + reconnect + epoch/schema handshakes, one stream

// ONE binding, next to the client: queries stay the chaining API; `useQuery`
// owns consumption — watch on mount, re-render on change, close on unmount
// (which also lets the cache evict what nothing watches, §7.6).
const { useQuery, useTransaction, usePresence } = createHooks(client);

// -----------------------------------------------------------------------------
// Queries — built once at module level; identity is the payload, so building
// them inline inside components works identically.
// -----------------------------------------------------------------------------

// The QUERY is the unit of everything — what syncs, what you read, what notifies.
// `orderBy().limit()` would make this a live WINDOW: the server ships only the
// window (0.6–1.4ms even over a 600k-triple store) and the window refills itself
// when rows fall out. Results are typed from the entity; a delta re-runs only the
// queries whose predicates it touches (0.01ms per re-run, stable row identity —
// unchanged rows keep === across runs, so a keyed UI re-renders one row).
const myTodos = Query.from(Todo)
  .where("owner", { id: DEMO_USER })
  .orderBy("text")
  .select({ text: true, completed: true, tags: true, owner: { name: true } });

const teamTodos = Query.from(Todo)
  .where("team", { id: DEMO_TEAM })
  .select({ text: true, completed: true, owner: { name: true } });

type MyTodo = ResultOf<typeof myTodos>;

// -----------------------------------------------------------------------------
// Mutations — DRAFTS inside transact (§9): property writes record INTENT
// (set/add/remove/delete on the wire, never deltas), the server compiles it
// against the truth, and the optimistic preview is visible before the network
// is touched. `useTransaction` is the React consumption: [run, state], where
// state resolves "committed" | "queued" (queued = durable in the outbox).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Components — no subscribe/close anywhere: useQuery is the whole lifecycle.
// -----------------------------------------------------------------------------

function MyTodos() {
  const todos = useQuery(myTodos);
  const [toggleTodo] = useTransaction((tx, todo: MyTodo) => {
    tx.edit(Todo, todo.id).completed = !todo.completed;
  });
  const [deleteTodo] = useTransaction((tx, todo: MyTodo) => tx.delete(todo.id));
  const [addTag] = useTransaction((tx, todo: MyTodo, tag: string) => {
    tx.edit(Todo, todo.id).tags.push(tag);
  });
  const name = todos.data[0]?.owner.name;
  return (
    <>
      <header>
        <h1>{name ? `${name}'s todos` : "My todos"}</h1>
        <span className="stats">live</span>
      </header>
      <NewTodoForm />
      <ul>
        {todos.data.map((todo) => (
          // Stable row identity (§11.4): an unchanged row keeps === across
          // re-runs, so React's reconciliation skips it by key.
          <li key={todo.id} className={todo.completed ? "done" : undefined}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => void toggleTodo(todo)}
            />
            <span className="text">{todo.text}</span>
            <span className="tags">
              {todo.tags.map((tag) => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </span>
            <button type="button" onClick={() => {
              const tag = prompt("Tag:");
              if (tag) void addTag(todo, tag);
            }}>+ tag</button>
            <button type="button" onClick={() => void deleteTodo(todo)}>delete</button>
          </li>
        ))}
      </ul>
    </>
  );
}

function NewTodoForm() {
  // `create` mints the id and REQUIRES the required fields — forget `completed`
  // and this does not compile (§4.5, moved to the compiler).
  const [addTodo, adding] = useTransaction((tx, text: string) => {
    tx.create(Todo, { text, completed: false, owner: { id: DEMO_USER } });
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem("text") as HTMLInputElement;
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        void addTodo(text);
      }}
    >
      <input name="text" placeholder="What needs doing?" autoComplete="off" />
      <button type="submit" disabled={adding.status === "pending"}>Add</button>
    </form>
  );
}

function TeamTodos() {
  const todos = useQuery(teamTodos);
  return (
    <>
      <h1 className="section">Team Platform</h1>
      <ul>
        {todos.data.map((todo) => (
          <li key={todo.id} className={todo.completed ? "done" : undefined}>
            <span className="text">{todo.text}</span>
            <span className="owner">{todo.owner.name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The inspector is deliberately META: it renders the raw cache. It re-renders
 * whenever the queries above do (they watch every demo predicate) and when
 * presence changes — reading client.size/version inline at render time.
 */
function StoreInspector() {
  const online = usePresence();
  const mine = useQuery(myTodos); // shares the SAME live watch as <MyTodos/>
  useQuery(teamTodos);
  const triples = client
    .snapshot()
    .sort((a: Triple, b: Triple) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const stats =
    mine.status === "outdated"
      ? "schema changed — refresh the page"
      : `${client.size} triples · v${client.version} · ${online.length} online` +
        (client.outboxCount > 0 ? ` · ${client.outboxCount} queued` : "");
  return (
    <>
      <header>
        <h1>The store</h1>
        <span className="stats">{stats}</span>
      </header>
      <p className="hint">
        Every row is one triple, and only the triples your queries may see arrive
        here — Ada's private todo never does.
      </p>
      <table>
        <thead>
          <tr><th>subject</th><th>predicate</th><th>object</th></tr>
        </thead>
        <tbody>
          {triples.map(([subject, predicate, object]) => (
            <tr key={`${subject} ${predicate} ${JSON.stringify(object)}`}>
              <td className="subject">{subject}</td>
              <td className="predicate">{predicate}</td>
              <td className={isRef(object) ? "object ref" : "object"}>
                {isRef(object) ? `→ ${object.id}` : JSON.stringify(object)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function App() {
  return (
    <main>
      <section className="panel">
        <MyTodos />
        <TeamTodos />
      </section>
      <section className="panel">
        <StoreInspector />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
