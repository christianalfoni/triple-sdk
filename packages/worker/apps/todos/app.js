// The todo board — the app this repo proved the SDK with — as a PLATFORM app:
// plain ES module, Preact + htm, no build step. `pnpm --filter worker seed`
// publishes it into the dev workspace through the same MCP calls an agent makes.
import { html, render } from "htm/preact";
import { useState } from "preact/hooks";
import { TripleClient, HttpTransport, Query, createHooks } from "triple-sdk/client";
import { schema, Todo } from "schema";
import { auth } from "auth";

const me = await auth.me();
if (!me) auth.login();

const client = new TripleClient({ schema, transport: new HttpTransport(auth.apiBase) });
const { useQuery, useTransaction, usePresence } = createHooks(client);
const isMember = me.role === "admin" || me.role === "member";

function Row({ todo, onToggle, onShare, onRemove, mine }) {
  return html`<li class="flex items-center gap-3 py-2 border-t border-slate-100 first:border-0">
    <input type="checkbox" checked=${todo.completed} onChange=${() => onToggle(todo)} class="h-4 w-4" />
    <span class=${"flex-1 " + (todo.completed ? "line-through text-slate-400" : "")}>${todo.text}</span>
    ${todo.owner ? html`<span class="text-xs text-slate-500">${todo.owner.name}</span>` : null}
    ${mine ? html`<button class="text-xs text-slate-500 hover:text-slate-900" onClick=${() => onShare(todo)}>
      ${todo.shared ? "unshare" : "share"}</button>` : null}
    ${mine ? html`<button class="text-xs text-slate-500 hover:text-red-600" onClick=${() => onRemove(todo)}>✕</button>` : null}
  </li>`;
}

function App() {
  const mine = useQuery(
    () => Query.from(Todo).where("owner", { id: me.actor }).orderBy("text")
      .select({ text: true, completed: true, shared: true }),
    [],
  );
  const board = useQuery(
    () => Query.from(Todo).where("shared", true).orderBy("text")
      .select({ text: true, completed: true, shared: true, owner: { name: true } }),
    [],
  );
  const online = usePresence();
  const [text, setText] = useState("");
  const [add] = useTransaction((tx, value, shared) => {
    tx.create(Todo, { text: value, completed: false, shared, owner: { id: me.actor } });
  });
  const [toggle] = useTransaction((tx, todo) => { tx.edit(Todo, todo.id).completed = !todo.completed; });
  const [share] = useTransaction((tx, todo) => { tx.edit(Todo, todo.id).shared = !todo.shared; });
  const [remove] = useTransaction((tx, todo) => { tx.delete(todo.id); });

  const submit = (event, shared) => {
    event.preventDefault();
    if (!text.trim()) return;
    add(text.trim(), shared);
    setText("");
  };

  return html`<main class="max-w-xl mx-auto p-6 font-sans text-slate-900">
    <header class="flex items-baseline gap-3 mb-4">
      <h1 class="text-2xl font-bold flex-1">Todos</h1>
      <span class="text-xs text-slate-500">${me.name} · ${me.role} · ${online.length} online</span>
      <button class="text-xs underline text-slate-500" onClick=${() => auth.logout()}>sign out</button>
    </header>

    <form class="flex gap-2 mb-6" onSubmit=${(e) => submit(e, false)}>
      <input class="flex-1 rounded-lg border border-slate-300 px-3 py-2" placeholder="Add a todo…"
        value=${text} onInput=${(e) => setText(e.currentTarget.value)} />
      <button type="submit" class="rounded-lg bg-slate-900 text-white px-4 py-2">Add</button>
      ${isMember ? html`<button type="button" class="rounded-lg border border-slate-300 px-4 py-2"
        onClick=${(e) => submit(e, true)}>Add to board</button>` : null}
    </form>

    <section class="rounded-xl border border-slate-200 bg-white p-4 mb-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Mine</h2>
      <ul>${mine.data.map((todo) => html`<${Row} key=${todo.id} todo=${todo} mine=${true}
        onToggle=${toggle} onShare=${share} onRemove=${remove} />`)}</ul>
      ${mine.status === "ready" && mine.data.length === 0 ? html`<p class="text-sm text-slate-400">Nothing yet.</p>` : null}
    </section>

    ${isMember ? html`<section class="rounded-xl border border-slate-200 bg-white p-4">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Board — shared with the workspace</h2>
      <ul>${board.data.map((todo) => html`<${Row} key=${todo.id} todo=${todo} mine=${false} onToggle=${toggle} />`)}</ul>
      ${board.status === "ready" && board.data.length === 0 ? html`<p class="text-sm text-slate-400">The board is empty.</p>` : null}
    </section>` : null}
  </main>`;
}

render(html`<${App} />`, document.getElementById("root"));
