/**
 * One workspace's board. The client is created per workspace (the key= in App
 * guarantees a fresh one on switch), persistence keyed by workspace, and every
 * read/write goes through the two hooks — no watch/subscribe/transact plumbing
 * in sight.
 *
 * The product's one interesting verb: SHARE. `shared` is a plain boolean on the
 * todo, but flipping it is a visibility change — other members watch the todo
 * appear or VANISH live (§10.6), and offline members heal at reconnect.
 */
import { HttpTransport, TripleClient } from "triple-sdk/client";
import { createHooks } from "triple-sdk/react";
import { Query, type ResultOf } from "triple-sdk/query";
import { schema, Todo } from "app-schema";
import { useMemo } from "react";

type Props = {
  me: { actor: string; name: string };
  workspaceId: string;
  workspaceName: string;
  onLeave: () => void;
};

export function Board({ me, workspaceId, workspaceName, onLeave }: Props) {
  const { client, hooks, queries } = useBoardClient(workspaceId, me.actor);
  const { useQuery, useTransaction, usePresence } = hooks;

  const mine = useQuery(queries.mine);
  const board = useQuery(queries.board);
  const online = usePresence();

  const [addTodo, adding] = useTransaction((tx, text: string, shared: boolean) => {
    tx.create(Todo, { text, completed: false, shared, owner: { id: me.actor } });
  });
  const [toggle] = useTransaction((tx, todo: BoardTodo) => {
    tx.edit(Todo, todo.id).completed = !todo.completed;
  });
  const [setShared] = useTransaction((tx, todo: BoardTodo, shared: boolean) => {
    tx.edit(Todo, todo.id).shared = shared;
  });
  const [remove] = useTransaction((tx, todo: BoardTodo) => tx.delete(todo.id));

  const status =
    mine.status === "outdated"
      ? "new version deployed — refresh"
      : `${online.length} online · v${client.version}` +
        (client.outboxCount > 0 ? ` · ${client.outboxCount} queued offline` : "");

  return (
    <main>
      <header className="top">
        <h1>{workspaceName}</h1>
        <span className="stats">{status}</span>
        <button className="link" onClick={onLeave}>switch workspace</button>
        <a className="link" href="/auth/logout">sign out</a>
      </header>

      <NewTodo onAdd={(text, shared) => void addTodo(text, shared)} busy={adding.status === "pending"} />

      <section className="panel">
        <h2>Private — only you can even know these exist</h2>
        <ul>
          {mine.data.map((todo) => (
            <TodoRow key={todo.id} todo={todo} mine
              onToggle={() => void toggle(todo)}
              onShare={() => void setShared(todo, !todo.shared)}
              onRemove={() => void remove(todo)} />
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Shared board — unshare and it vanishes from everyone else, live</h2>
        <ul>
          {board.data.map((todo) => (
            <TodoRow key={todo.id} todo={todo} mine={todo.owner.id === me.actor}
              onToggle={() => void toggle(todo)}
              onShare={() => void setShared(todo, !todo.shared)}
              onRemove={() => void remove(todo)} />
          ))}
        </ul>
      </section>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Client + queries, once per workspace
// -----------------------------------------------------------------------------

function useBoardClient(workspaceId: string, actor: string) {
  return useMemo(() => {
    const client = new TripleClient({
      schema,
      transport: new HttpTransport(`/w/${workspaceId}/api`),
      persistence: {
        load: () => localStorage.getItem(`todos:${workspaceId}`),
        save: (state) => localStorage.setItem(`todos:${workspaceId}`, state),
      },
    });
    client.connect();
    const queries = {
      mine: Query.from(Todo)
        .where("owner", { id: actor })
        .where("shared", false)
        .orderBy("text")
        .select({ text: true, completed: true, shared: true, owner: { name: true } }),
      board: Query.from(Todo)
        .where("shared", true)
        .orderBy("text")
        .select({ text: true, completed: true, shared: true, owner: { name: true } }),
    };
    return { client, hooks: createHooks(client), queries };
  }, [workspaceId, actor]);
}

type BoardTodo = ResultOf<ReturnType<typeof useBoardClient>["queries"]["board"]>;

// -----------------------------------------------------------------------------
// Pieces
// -----------------------------------------------------------------------------

function TodoRow(props: {
  todo: BoardTodo;
  mine: boolean;
  onToggle: () => void;
  onShare: () => void;
  onRemove: () => void;
}) {
  const { todo, mine } = props;
  return (
    <li className={todo.completed ? "done" : undefined}>
      {/* anyone may tick a shared todo (the per-field override); only yours otherwise */}
      <input type="checkbox" checked={todo.completed} onChange={props.onToggle} />
      <span className="text">{todo.text}</span>
      <span className="owner">{todo.owner.name}</span>
      {mine && (
        <>
          <button type="button" onClick={props.onShare}>
            {todo.shared ? "unshare" : "share"}
          </button>
          <button type="button" onClick={props.onRemove}>delete</button>
        </>
      )}
    </li>
  );
}

function NewTodo({ onAdd, busy }: { onAdd: (text: string, shared: boolean) => void; busy: boolean }) {
  return (
    <form
      className="new"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const text = (form.elements.namedItem("text") as HTMLInputElement).value.trim();
        const shared = (form.elements.namedItem("shared") as HTMLInputElement).checked;
        if (!text) return;
        (form.elements.namedItem("text") as HTMLInputElement).value = "";
        onAdd(text, shared);
      }}
    >
      <input name="text" placeholder="What needs doing?" autoComplete="off" />
      <label><input type="checkbox" name="shared" /> shared</label>
      <button type="submit" disabled={busy}>Add</button>
    </form>
  );
}
