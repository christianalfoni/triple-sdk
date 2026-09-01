/**
 * The shell: who am I (/api/me), which workspaces (/api/workspaces — WorkOS
 * organizations), then one Board per chosen workspace. A 401 anywhere means
 * "go sign in" — the worker's AuthKit redirect handles the rest.
 */
import { useEffect, useState } from "react";
import { Board } from "./Board.tsx";

type Me = { actor: string; name: string };
type Workspace = { id: string; name: string };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [current, setCurrent] = useState<string | null>(
    () => new URLSearchParams(location.search).get("w"),
  );

  useEffect(() => {
    void (async () => {
      const meResponse = await fetch("/api/me");
      if (meResponse.status === 401) {
        location.href = "/auth/login";
        return;
      }
      setMe((await meResponse.json()) as Me);
      const list = (await (await fetch("/api/workspaces")).json()) as Workspace[];
      setWorkspaces(list);
      if (list.length === 1) setCurrent((c) => c ?? list[0]!.id);
    })();
  }, []);

  if (!me || !workspaces) return <main className="center">loading…</main>;

  if (!current) {
    return (
      <main className="center">
        <h1>Your workspaces</h1>
        <ul className="workspaces">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button onClick={() => pick(workspace.id, setCurrent)}>{workspace.name}</button>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const workspace = workspaces.find((w) => w.id === current);
  return (
    <Board
      key={current} // a workspace change is a NEW client, cache and all
      me={me}
      workspaceId={current}
      workspaceName={workspace?.name ?? current}
      onLeave={() => pick(null, setCurrent)}
    />
  );
}

function pick(id: string | null, set: (v: string | null) => void): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set("w", id);
  else url.searchParams.delete("w");
  history.pushState(null, "", url);
  set(id);
}
