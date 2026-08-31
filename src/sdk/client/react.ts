/**
 * React binding — the ONE hook that hides the watch lifecycle.
 *
 * Queries are still BUILT with the chaining API (that part is the language of
 * the system); `useQuery` only owns consumption: create the watch, subscribe,
 * re-render on change, close on unmount — the `watch()/subscribe()/close()`
 * choreography an app would otherwise hand-write per component.
 *
 * Query identity is the REFERENCE, under React's own rule for values used in
 * render: hold it stable, or memoize it with deps. Hence exactly two call
 * shapes, mirroring `useMemo`:
 *
 *   const myTodos = Query.from(Todo).where("owner", me).select({ text: true });
 *   function Todos() {
 *     const todos = useQuery(myTodos);            // stable reference
 *     ...
 *   }
 *
 *   function UserTodos({ userId }: { userId: string }) {
 *     const todos = useQuery(
 *       () => Query.from(Todo).where("owner", { id: userId }).select({ text: true }),
 *       [userId],                                 // deps decide when it is a NEW query
 *     );
 *     ...
 *   }
 *
 * When the reference changes (deps fired, or a new stable query), the old watch
 * closes — which also lets the cache evict (§7.6) — and the new one attaches.
 * The first render is LOCAL-FIRST like everything else: before the watch
 * attaches (an effect), the hook reads the same rows synchronously from the
 * cache — a hydrated client paints data before (or without) the network.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EntityResult, QueryBuilder } from "../shared/query.ts";
import type { EntityDef } from "../shared/schema.ts";
import type { Id } from "../shared/types.ts";
import type { LiveQuery, QueryStatus, TripleClient } from "./client.ts";

export type UseQueryResult<
  E extends EntityDef,
  Sel,
  K extends (keyof E & string) | undefined,
> = {
  data: EntityResult<E, Sel>[];
  status: QueryStatus;
  error: Error | undefined;
  /** §6.6 — ready for `.after(result.cursor)` on ordered queries. */
  cursor: LiveQuery<E, Sel, K>["cursor"];
};

/** Bind the hooks to YOUR client once, at module level, next to the client. */
export function createHooks(client: TripleClient) {
  function useQuery<
    E extends EntityDef,
    Sel,
    K extends (keyof E & string) | undefined,
  >(query: QueryBuilder<E, Sel, K>): UseQueryResult<E, Sel, K>;
  function useQuery<
    E extends EntityDef,
    Sel,
    K extends (keyof E & string) | undefined,
  >(
    make: () => QueryBuilder<E, Sel, K>,
    deps: readonly unknown[],
  ): UseQueryResult<E, Sel, K>;
  function useQuery<
    E extends EntityDef,
    Sel,
    K extends (keyof E & string) | undefined,
  >(
    queryOrMake: QueryBuilder<E, Sel, K> | (() => QueryBuilder<E, Sel, K>),
    deps?: readonly unknown[],
  ): UseQueryResult<E, Sel, K> {
    // One useMemo serves both shapes so the hook order never varies: the direct
    // form's "deps" is the query reference itself.
    const query = useMemo(
      () => (typeof queryOrMake === "function" ? queryOrMake() : queryOrMake),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- by design: deps ARE the contract
      typeof queryOrMake === "function" ? deps! : [queryOrMake],
    );
    const cell = useMemo(() => makeCell(client, query), [query]);
    useEffect(() => cell.attach(), [cell]);
    useSyncExternalStore(cell.subscribe, cell.version, cell.version);
    return cell.read();
  }

  /** The live roster (§13): re-renders on join/leave diffs. */
  function usePresence(): readonly Id[] {
    return useSyncExternalStore(
      (onChange) => client.onPresence(onChange),
      () => client.presence,
      () => client.presence,
    );
  }

  return { useQuery, usePresence };
}

/**
 * One watch's bridge to React. `version` is the external-store snapshot — a
 * counter bumped on every emission, so React re-reads `read()` exactly when the
 * live query said something changed (rows, status, or error alike).
 */
function makeCell<
  E extends EntityDef,
  Sel,
  K extends (keyof E & string) | undefined,
>(client: TripleClient, query: QueryBuilder<E, Sel, K>) {
  let live: LiveQuery<E, Sel, K> | undefined;
  let bumps = 0;
  const listeners = new Set<() => void>();
  return {
    /** Effect-time: create the watch; the cleanup closes it (and may evict, §7.6). */
    attach(): () => void {
      const watched = client.watch(query);
      live = watched;
      const off = watched.subscribe(() => {
        bumps++;
        for (const listener of listeners) listener();
      });
      return () => {
        off();
        watched.close();
        if (live === watched) live = undefined;
      };
    },
    subscribe(onChange: () => void): () => void {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    version: (): number => bumps,
    read(): UseQueryResult<E, Sel, K> {
      if (live !== undefined) {
        return { data: live.data, status: live.status, error: live.error, cursor: live.cursor };
      }
      // Render-time, pre-attach: the cache answers synchronously (§7.6).
      return {
        data: client.run(query),
        status: "loading",
        error: undefined,
        cursor: undefined as UseQueryResult<E, Sel, K>["cursor"],
      };
    },
  };
}
