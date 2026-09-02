// The first internal app a fresh workspace wants: who is here. `Query.from(User)`
// with no constraint is every member this viewer may see — members see the
// whole roster, an app user sees only themselves (the workspace's own rule).
import { html, render } from "htm/preact";
import { TripleClient, HttpTransport, Query, createHooks } from "triple-sdk/client";
import { schema, User } from "schema";
import { auth } from "auth";

const me = await auth.me();
if (!me) auth.login();

const client = new TripleClient({ schema, transport: new HttpTransport(auth.apiBase) });
const { useQuery, usePresence } = createHooks(client);

function App() {
  const members = useQuery(
    () => Query.from(User).orderBy("name").select({ name: true, role: true, email: true }),
    [],
  );
  const online = usePresence();
  return html`<main class="max-w-xl mx-auto p-6 font-sans text-slate-900">
    <h1 class="text-2xl font-bold mb-4">Members</h1>
    <ul class="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
      ${members.data.map((member) => html`<li key=${member.id} class="flex items-center gap-3 px-4 py-3">
        <span class=${"h-2 w-2 rounded-full " + (online.includes(member.id) ? "bg-emerald-500" : "bg-slate-300")}></span>
        <span class="flex-1">${member.name}${member.id === me.actor ? " (you)" : ""}</span>
        <span class="text-xs text-slate-500">${member.email ?? ""}</span>
        <span class="text-xs rounded-full bg-slate-100 px-2 py-0.5">${member.role}</span>
      </li>`)}
    </ul>
  </main>`;
}

render(html`<${App} />`, document.getElementById("root"));
