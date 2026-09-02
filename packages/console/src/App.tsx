/**
 * The console — the service's own website. Sign in, create a workspace or
 * pick one you belong to, then: the workspace's apps, its members, and how to
 * connect an agent. It is a plain client of the edge (/api) and of one
 * workspace cell (/w/<id>/api) at a time.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Workspace } from "./Workspace.tsx";

export type Me = { actor: string; name: string; email?: string };
export type WorkspaceEntry = { id: string; name: string; role: "admin" | "member" };

export function App() {
  const [me, setMe] = useState<Me | null | "anonymous">(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [current, setCurrent] = useState<string | null>(() => new URLSearchParams(location.search).get("w"));
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/me");
      if (response.status === 401) return setMe("anonymous");
      setMe((await response.json()) as Me);
      setWorkspaces((await (await fetch("/api/workspaces")).json()) as WorkspaceEntry[]);
    })();
  }, []);

  if (me === "anonymous") {
    return (
      <main className="center">
        <h1>Workspaces</h1>
        <p className="muted">A workspace is a place with data, rules, and the apps an agent builds on them.</p>
        <a className="button" href={`/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`}>
          Sign in
        </a>
      </main>
    );
  }
  if (!me || !workspaces) return <main className="center">loading…</main>;

  const workspace = current ? workspaces.find((w) => w.id === current) : undefined;
  if (workspace) {
    return <Workspace key={workspace.id} me={me} workspace={workspace} onLeave={() => pick(null, setCurrent)} />;
  }

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name") as string;
    if (!name.trim()) return;
    setCreating(true);
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const created = (await response.json()) as WorkspaceEntry;
    setWorkspaces([...workspaces, created]);
    setCreating(false);
    pick(created.id, setCurrent);
  };

  return (
    <main className="center">
      <h1>Your workspaces</h1>
      <p className="muted">Signed in as {me.name}. <a className="link" href="/auth/logout">Sign out</a></p>
      {workspaces.length > 0 && (
        <ul className="workspaces">
          {workspaces.map((entry) => (
            <li key={entry.id}>
              <button onClick={() => pick(entry.id, setCurrent)}>
                {entry.name} <span className="badge">{entry.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="new" onSubmit={create}>
        <input name="text" hidden />
        <input name="name" placeholder="New workspace name" required />
        <button type="submit" disabled={creating}>Create</button>
      </form>
    </main>
  );
}

function pick(id: string | null, set: (value: string | null) => void): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set("w", id);
  else url.searchParams.delete("w");
  history.pushState(null, "", url);
  set(id);
}
