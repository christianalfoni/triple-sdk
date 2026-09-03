/**
 * One workspace: its apps (a live query on the App registry — an agent's
 * publish shows up here without a refresh), its members, and the agent
 * hookup. The console is an ordinary client of the workspace cell: the same
 * TripleClient, the same policy, the member's own standing.
 */
import { useMemo, useState, type FormEvent } from "react";
import { HttpTransport, TripleClient } from "triple-sdk/client";
import { Query } from "triple-sdk/query";
import { createHooks } from "triple-sdk/react";
import { App as AppEntity, schema, User } from "app-schema";
import type { Me, WorkspaceEntry } from "./App.tsx";

export function Workspace({ me, workspace, onLeave }: { me: Me; workspace: WorkspaceEntry; onLeave: () => void }) {
  const hooks = useMemo(() => {
    const client = new TripleClient({
      schema,
      transport: new HttpTransport(`/w/${workspace.id}/api`),
      persistence: {
        load: () => localStorage.getItem(`console:${workspace.id}`),
        save: (state) => localStorage.setItem(`console:${workspace.id}`, state),
      },
    });
    client.connect();
    return createHooks(client);
  }, [workspace.id]);
  const { useQuery, usePresence } = hooks;

  const apps = useQuery(
    () => Query.from(AppEntity).orderBy("name").select({ name: true, audience: true, live: { version: true } }),
    [],
  );
  const members = useQuery(() => Query.from(User).orderBy("name").select({ name: true, role: true, email: true }), []);
  const online = usePresence();
  const [token, setToken] = useState<{ token: string; mcp: string } | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const mint = async () => {
    const response = await fetch(`/w/${workspace.id}/api/tokens`, { method: "POST" });
    setToken((await response.json()) as { token: string; mcp: string });
  };
  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get("email") as string;
    const response = await fetch(`/w/${workspace.id}/api/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setInvited(((await response.json()) as { message?: string; error?: string }).message ?? "could not invite");
    form.reset();
  };

  const appBase = `/w/${workspace.id}/apps`;
  return (
    <main>
      <div className="top">
        <h1>{workspace.name}</h1>
        <span className="stats">{me.name} · {workspace.role} · {online.length} online</span>
        <button className="link" onClick={onLeave}>all workspaces</button>
      </div>

      <section className="panel">
        <h2>Apps</h2>
        {apps.status === "ready" && apps.data.length === 0 && (
          <p className="muted">No apps yet. Connect an agent below and ask it for the first one — a members list is a good start.</p>
        )}
        <ul>
          {apps.data.map((app) => (
            <li key={app.id}>
              <span className="text">
                {app.live ? <a href={`${appBase}/${app.name}/`}>{app.name}</a> : app.name}
                <span className="owner"> · {app.audience}{app.live ? ` · v${app.live.version}` : " · not published"}</span>
              </span>
              <a className="link" href={`${appBase}/${app.name}/draft/`}>draft</a>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Members</h2>
        <ul>
          {members.data.map((member) => (
            <li key={member.id}>
              <span className={online.includes(member.id) ? "dot online" : "dot"} />
              <span className="text">{member.name}{member.id === me.actor ? " (you)" : ""}</span>
              <span className="owner">{member.email ?? ""}</span>
              <span className="badge">{member.role}</span>
            </li>
          ))}
        </ul>
        {workspace.role === "admin" && (
          <form className="new" onSubmit={invite}>
            <input name="email" type="email" placeholder="Invite by email" required />
            <button type="submit">Invite</button>
          </form>
        )}
        {invited && <p className="muted">{invited}</p>}
      </section>

      <section className="panel">
        <h2>Build with an agent</h2>
        <p className="muted">
          <strong>From a chat</strong> — in claude.ai, Customize → Connectors → Add custom connector, with this URL,
          then Connect and sign in with the same account. Ask for an app; it appears above.
        </p>
        <pre className="code">{`${location.origin}/mcp`}</pre>
        <p className="muted">
          <strong>From Claude Code</strong> — a token for this workspace, thirty days:
        </p>
        {token ? (
          <pre className="code">{`claude mcp add --transport http workspace ${token.mcp} \\
  --header "Authorization: Bearer ${token.token}"`}</pre>
        ) : (
          <button className="primary" onClick={mint}>Create an agent token</button>
        )}
      </section>
    </main>
  );
}
