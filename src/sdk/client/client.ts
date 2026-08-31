/**
 * The client half of the SDK.
 *
 * The query is the unit of everything (SPEC §7.5): it decides what syncs, what you can
 * read, and what you get notified about. There is no "fetch the whole store", and no
 * client-wide change callback — both were ways of pretending the client holds
 * everything, which it does not.
 *
 *   const todos = client.watch(myTodos)      // syncs, then stays live
 *   todos.subscribe((rows) => render(rows))
 *   todos.data                                // synchronous, [] until loaded
 *   todos.status                              // "loading" | "ready" | "error"
 *   todos.close()
 */

import {
  collectPayloadTriples,
  queryPredicates,
  resultKey,
  runQuery,
  toPayload,
  type EntityResult,
  type QueryBuilder,
  type ValueOfField,
} from "../shared/query.ts";
import type { AppSchema, EntityDef, Schema } from "../shared/schema.ts";
import { Store, withDelta } from "../shared/store.ts";
import { tripleKey } from "../shared/value.ts";
import { Transaction } from "../shared/transaction.ts";
import type { Delta, Id, Readable, Triple } from "../shared/types.ts";
import type { DeltaMessage, Operation, StreamMessage } from "../shared/protocol.ts";
import { SchemaMismatchError, type Transport } from "./transport.ts";

/**
 * SPEC §13 — where the client survives a reload. Synchronous on purpose, so boot
 * stays synchronous: `localStorage` in a browser, a file or memory in tests. The
 * saved state is discarded when the schema hash differs (old cache, new code), and
 * the saved EPOCH rides along so a stale cache meets the same resync machinery a
 * stale connection does.
 */
export interface ClientPersistence {
  load(): string | null;
  save(state: string): void;
}

export type TripleClientOptions = {
  /** The app's schema — the same `Schema.build({...})` the server holds (SPEC §10.1). */
  schema: AppSchema;
  transport: Transport;
  persistence?: ClientPersistence;
};

/**
 * Note what this does NOT take: an identity. The client does not tell the server who
 * it is — the server derives that from the authenticated connection (SPEC §7.4).
 */
export class TripleClient {
  /** The flat predicate map. The triple layer speaks predicates, not entities. */
  readonly schema: Schema;

  /**
   * SPEC §8.1 — two layers, never merged.
   *
   * `#confirmed` holds only what the server has said: query results, acks, pushed
   * deltas. `#pending` holds local mutations not yet answered, in order. Reads see
   * `confirmed + pending` layered on the fly, so dropping a pending delta — ack or
   * reject alike — is a clean discard, never an unwind.
   *
   * The confirmed layer is PARTIAL by construction (SPEC §7.6): read through a
   * query, not through this.
   */
  #confirmed = new Store();
  #pending: { mutationId: string; delta: Delta }[] = [];

  #transport: Transport;
  #version = 0;
  #mutationCounter = 0;
  #disconnect?: () => void;
  #epoch?: number;
  #ephemeralListeners = new Set<(actor: Id, payload: unknown) => void>();
  #presenceListeners = new Set<(online: Id[]) => void>();
  /** Distinct actors with an open stream on this cell (SPEC §13). */
  presence: Id[] = [];
  readonly #schemaHash: string;
  #outdated = false;
  /** Serializes sends: one mutation in flight at a time, in order (§8.2). */
  #sendChain: Promise<unknown> = Promise.resolve();
  /**
   * SPEC §13 — writes that could not reach the server, as INTENT, in order. Intent
   * is what makes a queue correct after days offline: the server compiles it
   * against present truth on arrival; replaying stale deltas would not be.
   */
  #outbox: { mutationId: string; operations: Operation[]; delta: Delta }[] = [];
  #draining = false;
  #drainTimer?: ReturnType<typeof setTimeout>;
  #persistence?: ClientPersistence;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #rejectedListeners = new Set<(mutationId: string, reason: string) => void>();
  #undelivered: { mutationId: string; reason: string }[] = [];
  #coalesced = new Map<string, { payload: unknown; about?: Id }>();
  #flushTimer?: ReturnType<typeof setTimeout>;
  #live = new Set<AnyLiveQuery>();

  constructor(options: TripleClientOptions) {
    this.schema = options.schema.flat;
    this.#schemaHash = options.schema.hash;
    this.#transport = options.transport;
    this.#persistence = options.persistence;
    this.#hydrate();
  }

  /** Boot from the last saved state, if it was written by this schema generation. */
  #hydrate(): void {
    const raw = this.#persistence?.load();
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as {
        schema: string;
        epoch?: number;
        version: number;
        triples: Triple[];
        outbox: { mutationId: string; operations: Operation[]; delta: Delta }[];
      };
      if (saved.schema !== this.#schemaHash) {
        // The CACHE is disposable across schema generations — the user's unsent
        // WRITES are not (§13). Carry over every outbox entry whose intent still
        // compiles against the new schema; surface the rest, never drop silently.
        for (const entry of saved.outbox) {
          const carriable = entry.operations.every((op) =>
            op.op === "delete" ? true : this.schema[op.predicate] !== undefined,
          );
          if (carriable) {
            this.#outbox.push(entry);
            this.#pending.push({ mutationId: entry.mutationId, delta: entry.delta });
          } else {
            this.#undelivered.push({
              mutationId: entry.mutationId,
              reason: "Unsent change could not be carried across a schema update.",
            });
          }
        }
        return;
      }
      this.#confirmed.apply({ added: saved.triples, removed: [] });
      this.#version = saved.version;
      this.#epoch = saved.epoch;
      for (const entry of saved.outbox) {
        this.#outbox.push(entry);
        this.#pending.push({ mutationId: entry.mutationId, delta: entry.delta });
      }
    } catch {
      // Corrupt state loses only a cache — the server has the truth.
    }
  }

  #lastSavedKey = "";

  #persist(): void {
    if (!this.#persistence) return;
    // Cheap dirty check before the O(store) stringify (§13): nothing durable
    // changed, nothing to save.
    const key = `${this.#version}|${this.#outbox.length}|${this.#confirmed.size}|${this.#pending.length}`;
    if (key === this.#lastSavedKey) return;
    this.#lastSavedKey = key;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#persistence!.save(
        JSON.stringify({
          schema: this.#schemaHash,
          epoch: this.#epoch,
          version: this.#version,
          triples: this.#confirmed.snapshot(),
          outbox: this.#outbox,
        }),
      );
    }, 100);
    this.#saveTimer.unref?.();
  }

  /** Notified when a QUEUED write is finally rejected by the server (§13). */
  onRejected(listener: (mutationId: string, reason: string) => void): () => void {
    this.#rejectedListeners.add(listener);
    for (const undelivered of this.#undelivered.splice(0)) {
      listener(undelivered.mutationId, undelivered.reason);
    }
    return () => this.#rejectedListeners.delete(listener);
  }

  get outboxCount(): number {
    return this.#outbox.length;
  }

  /** The last server version this client has seen. The sync cursor (SPEC §3.2). */
  get version(): number {
    return this.#version;
  }

  /**
   * True once the server is known to run a different schema generation (§7.3).
   * From then on EVERY read and write throws, watched queries flip to "outdated",
   * and the stream is closed — the only way forward is a refresh, so the app is
   * frozen loudly instead of showing quietly-wrong emptiness.
   */
  get outdated(): boolean {
    return this.#outdated;
  }

  #outdate(): void {
    if (this.#outdated) return;
    this.#outdated = true;
    this.disconnect();
    for (const live of this.#live) live.markOutdated();
  }

  #assertCurrent(): void {
    if (this.#outdated) {
      throw new SchemaMismatchError();
    }
  }

  /** Local mutations awaiting the server's answer (SPEC §8.2). */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** How many triples reads currently see. For the demo's inspector, not for reading. */
  get size(): number {
    return this.snapshot().length;
  }

  /** Every triple reads currently see — confirmed + pending. Inspection only. */
  snapshot(): Triple[] {
    return this.#view().match([undefined, undefined, undefined]);
  }

  /**
   * What reads resolve against: the confirmed store with every pending delta
   * layered over it (SPEC §8.1). Rebuilt per read — the layers are lazy wrappers,
   * and pending is rarely more than a delta or two deep.
   */
  #view(): Readable {
    let view: Readable = this.#confirmed;
    for (const mutation of this.#pending) view = withDelta(view, mutation.delta);
    return view;
  }

  // ---------------------------------------------------------------------------
  // Live sync (SPEC §7.7)
  // ---------------------------------------------------------------------------

  /**
   * Open the delta stream. From here on, every committed change this actor may see
   * arrives as a push and re-runs the affected live queries — no refresh.
   *
   * The client's own writes echo back too; the version cursor makes that a no-op
   * (`#applyRemote` skips anything at or below the version the ack already applied).
   */
  connect(): void {
    if (this.#disconnect) return;
    this.#disconnect = this.#transport.deltas(
      () => this.#version,
      (message) => this.#onStream(message),
    );
    this.#scheduleDrain();
  }

  disconnect(): void {
    this.#disconnect?.();
    this.#disconnect = undefined;
  }

  /**
   * SPEC §13 — the multiplayer fast path. Send transient state (cursor, drag in
   * progress, typing preview) to everyone connected, at whatever frequency the UI
   * wants. Never logged, never versioned, LOSSY BY DESIGN — commit the settled
   * value through `transact` when the interaction ends.
   */
  broadcast(payload: unknown, options?: { about?: Id; key?: string }): void {
    this.#assertCurrent();
    // Coalesced (§13): within each ~33ms window only the LATEST payload per key is
    // sent — a 60Hz drag costs ≤30 requests/sec, and dropping stale frames is the
    // point of an ephemeral channel.
    const key = options?.key ?? "";
    this.#coalesced.set(key, { payload, about: options?.about });
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      const batch = [...this.#coalesced.values()];
      this.#coalesced.clear();
      for (const entry of batch) {
        void this.#transport
          .broadcast({ kind: "broadcast", payload: entry.payload, about: entry.about })
          .catch(() => {
            // Ephemeral means ephemeral: a lost cursor frame is not worth an error.
          });
      }
    }, 33);
    this.#flushTimer.unref?.();
  }

  /** Ephemeral payloads from other clients (and echoes of our own). */
  onEphemeral(listener: (actor: Id, payload: unknown) => void): () => void {
    this.#ephemeralListeners.add(listener);
    return () => this.#ephemeralListeners.delete(listener);
  }

  onPresence(listener: (online: Id[]) => void): () => void {
    this.#presenceListeners.add(listener);
    if (this.presence.length > 0) listener(this.presence);
    return () => this.#presenceListeners.delete(listener);
  }

  #onStream(message: StreamMessage): void {
    if (message.kind === "resync") {
      // §7.3 — same history, but our cursor predates the retained log. The gap is
      // unreplayable, so fall back to state: exactly the epoch move.
      this.#resync();
      return;
    }
    if (message.kind === "ephemeral") {
      for (const listener of this.#ephemeralListeners) listener(message.actor, message.payload);
      return;
    }
    if (message.kind === "presence") {
      if (message.online) this.presence = message.online;
      else if (message.joined && !this.presence.includes(message.joined))
        this.presence = [...this.presence, message.joined];
      else if (message.left)
        this.presence = this.presence.filter((id) => id !== message.left);
      for (const listener of this.#presenceListeners) listener(this.presence);
      return;
    }
    if (message.kind === "repair") {
      // §10.6 — catch-up visibility repair: drop every cached triple of the
      // evicted subjects (we may no longer see them; the backlog could not say
      // so), absorb the refreshed current state, and re-run what watched them.
      const removed = message.evict.flatMap((subject) =>
        this.#confirmed.match([subject, undefined, undefined]),
      );
      const effective = this.#confirmed.apply({ added: message.refresh.added, removed });
      this.#notify(effective);
      return;
    }
    if (message.kind === "hello") {
      // §7.3 — freeze unless this client's generation is one the server accepts.
      const accepted =
        message.schema === this.#schemaHash ||
        (message.compatible?.includes(this.#schemaHash) ?? false);
      if (!accepted) {
        this.#outdate();
        return;
      }
      // A different epoch means the server's history or policy is not the
      // one this cache was built against: drop everything and re-query.
      if (this.#epoch !== undefined && this.#epoch !== message.epoch) {
        this.#epoch = message.epoch;
        this.#resync();
      } else {
        this.#epoch = message.epoch;
      }
      return;
    }
    this.#applyRemote(message);
  }

  #resync(): void {
    this.#confirmed = new Store();
    this.#version = 0;
    for (const live of this.#live) void live.refresh();
  }

  /** SPEC §8.2 — a remote delta lands in confirmed; pending stays as-is. */
  #applyRemote(message: DeltaMessage): void {
    if (message.version <= this.#version) return;
    const effective = this.#confirmed.apply(message.delta);
    this.#version = message.version;
    this.#notify(effective);
  }

  // ---------------------------------------------------------------------------
  // Watching
  // ---------------------------------------------------------------------------

  /**
   * Start watching a query: fetch what it needs, then keep its results current as
   * local writes land. Returns immediately with `status: "loading"`.
   */
  watch<E extends EntityDef, Sel, K extends (keyof E & string) | undefined>(
    query: QueryBuilder<E, Sel, K>,
  ): LiveQuery<E, Sel, K> {
    this.#assertCurrent();
    const live = new LiveQuery(this, query);
    this.#live.add(live as AnyLiveQuery);
    return live;
  }

  /** Called by LiveQuery.close(). */
  release(live: AnyLiveQuery): void {
    this.#live.delete(live);
    this.#evict();
  }

  /**
   * §7.6 — the cache holds exactly what the remaining live queries need. On every
   * close, re-collect each survivor's triples against the local view (the same
   * collector the server runs, §6) and drop the rest — closing the one unbounded
   * growth on the client. Pushes for closed queries regrow it only until the
   * next close; `evict()` is public for a manual sweep.
   */
  evict(): void {
    this.#evict();
  }

  #evict(): void {
    const view = this.#view();
    const needed = new Set<string>();
    for (const live of this.#live) {
      for (const triple of collectPayloadTriples(view, toPayload(live.query))) {
        needed.add(tripleKey(triple));
      }
    }
    const removed = this.#confirmed
      .snapshot()
      .filter((triple) => !needed.has(tripleKey(triple)));
    if (removed.length === 0) return;
    this.#confirmed.apply({ added: [], removed });
    this.#persist();
  }

  /**
   * Called by LiveQuery to fetch and cache its triples.
   *
   * SPEC §7.3 — how a snapshot relates to further deltas. Every state answer is
   * STAMPED with the version it was computed at, and the rule is:
   *
   *   - A snapshot may only be applied if its version is AT OR BEYOND the cursor.
   *     The stream and the request travel on different channels, so a pushed delta
   *     can overtake an in-flight response — applying the older snapshot would
   *     resurrect triples the delta already replaced. Stale → ask again; versions
   *     only grow, so this converges.
   *   - The CURSOR IS STREAM-OWNED once the cache holds anything. A mid-session
   *     load never advances it: jumping the cursor over undelivered stream entries
   *     would version-skip their removals, and an additive snapshot apply cannot
   *     express "this triple is gone". Only an empty cache (fresh client, or just
   *     after resync) takes the snapshot's version as its starting cursor.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async load(query: QueryBuilder<any, any, any>): Promise<void> {
    this.#assertCurrent();
    const payload = toPayload(query);

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.#transport.query({
          kind: "query",
          schema: this.#schemaHash,
          payload,
        });
      } catch (cause) {
        if (cause instanceof SchemaMismatchError) this.#outdate();
        throw cause;
      }

      if (response.version >= this.#version) {
        this.#confirmed.apply({ added: response.triples, removed: [] });
        if (this.#version === 0) this.#version = response.version;
        this.#notify({ added: response.triples, removed: [] });
        return;
      }

      if (attempt >= 4) {
        throw new Error(
          "Could not obtain a snapshot at or beyond the stream position.",
        );
      }
    }
  }

  /** Called by LiveQuery to re-run itself against the local cache. */
  run<E extends EntityDef, Sel>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: QueryBuilder<E, Sel, any>,
  ): EntityResult<E, Sel>[] {
    this.#assertCurrent();
    return runQuery(this.#view(), this.schema, query);
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /**
   * SPEC §8.2 — an optimistic write.
   *
   * The delta becomes visible SYNCHRONOUSLY: it is pushed onto the pending layer
   * and affected queries re-run before the network is touched. Everything after the
   * `await` is bookkeeping:
   *
   *   ack     confirmed absorbs the server's effective delta, pending entry dropped
   *   reject  pending entry dropped — reads recompute, so the UI reverts on its own
   *   network failure  same as reject; there is no offline queue (§11.1)
   *
   * There is no replay of the mutation FUNCTION, only of its delta (§8.1): `build`
   * runs exactly once, against confirmed + pending at that moment.
   *
   * Sends are SERIALIZED — one mutation in flight at a time, in the order written.
   * Concurrent HTTP requests can arrive at the server out of order, and a delta
   * built on an earlier optimistic write is only valid after that write landed
   * (the server would otherwise see, say, an update to a todo that does not exist
   * yet and derive the wrong verb). The optimistic layer keeps the UI instant; only
   * the wire waits.
   */
  async transact(build: (tx: Transaction) => void): Promise<"committed" | "queued"> {
    this.#assertCurrent();
    const tx = new Transaction(this.schema, this.#view());
    build(tx);
    const { operations, delta } = tx.build();
    // Unique within this client only — that is all it needs to be, since the
    // client matches acks against its own pending list (SPEC §8.2).
    const mutationId = `m${++this.#mutationCounter}`;

    this.#pending.push({ mutationId, delta });
    this.#notify(delta);

    // Order is sacred: while queued writes exist, new ones join the queue rather
    // than overtaking it (§13).
    if (this.#outbox.length > 0) {
      this.#outbox.push({ mutationId, operations, delta });
      this.#persist();
      this.#scheduleDrain();
      return "queued";
    }

    const send = this.#sendChain.then(() =>
      this.#transport.transact({
        kind: "transact",
        schema: this.#schemaHash,
        mutationId,
        operations,
      }),
    );
    // The chain must survive a failed send — the NEXT mutation still goes out.
    this.#sendChain = send.catch(() => {});

    let response;
    try {
      response = await send;
    } catch (cause) {
      if (cause instanceof SchemaMismatchError) {
        this.#drop(mutationId);
        this.#outdate();
        throw cause;
      }
      // Network trouble (§13): keep the optimistic layer, queue the INTENT, and
      // resolve — the write is durable locally and will land when the wire heals.
      this.#outbox.push({ mutationId, operations, delta });
      this.#persist();
      this.#scheduleDrain();
      return "queued";
    }

    if (response.kind === "reject") {
      this.#drop(mutationId);
      throw new Error(`Transaction rejected: ${response.reason}`);
    }

    // The server's delta, not ours: §9.1 may have derived removes we could not
    // see, and §10.6 may have appended visibility diffs our write caused — so
    // notify for ITS predicates too, not only the pending delta's. The cursor is
    // NOT advanced here (§7.3): our own echo arrives on the stream in order, and
    // jumping past writes we have not yet received would skip their removals.
    this.#confirmed.apply(response.delta);
    this.#notify(response.delta);
    this.#drop(mutationId);
    return "committed";
  }

  #scheduleDrain(): void {
    if (this.#drainTimer || this.#draining) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = undefined;
      void this.#drain();
    }, 1000);
    this.#drainTimer.unref?.();
  }

  /** Replay the outbox serially; stop on network trouble and retry later (§13). */
  async #drain(): Promise<void> {
    if (this.#draining || this.#outdated) return;
    this.#draining = true;
    try {
      while (this.#outbox.length > 0) {
        const entry = this.#outbox[0]!;
        let response;
        try {
          response = await this.#transport.transact({
            kind: "transact",
            schema: this.#schemaHash,
            mutationId: entry.mutationId,
            operations: entry.operations,
          });
        } catch (cause) {
          if (cause instanceof SchemaMismatchError) this.#outdate();
          else this.#scheduleDrain();
          return;
        }
        this.#outbox.shift();
        if (response.kind === "reject") {
          for (const listener of this.#rejectedListeners) {
            listener(entry.mutationId, response.reason);
          }
        } else {
          this.#confirmed.apply(response.delta);
          this.#notify(response.delta);
        }
        this.#drop(entry.mutationId);
        this.#persist();
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Remove one pending delta and re-run the queries it touched (SPEC §8.2). */
  #drop(mutationId: string): void {
    const index = this.#pending.findIndex((m) => m.mutationId === mutationId);
    if (index === -1) return;
    const [dropped] = this.#pending.splice(index, 1);
    this.#notify(dropped!.delta);
  }

  /**
   * SPEC §6.4 — route a delta to the live queries it can possibly affect.
   *
   * A query is affected only if the delta touches one of its predicates, so an
   * unrelated write costs one set lookup per live query rather than a re-run.
   */
  #notify(delta: Delta): void {
    this.#persist();
    const touched = new Set(
      [...delta.added, ...delta.removed].map((triple) => triple[1]),
    );
    for (const live of this.#live) {
      if (live.affectedBy(touched)) live.rematerialize();
    }
  }
}

export type QueryStatus = "loading" | "ready" | "error" | "outdated";

/**
 * One watched query. Owns its own results, status and subscribers (SPEC §7.5).
 *
 * Subscribing per query rather than per client is what makes §6.4 possible: the
 * client knows which predicates each query touches, so a delta wakes only the queries
 * that could have changed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyLiveQuery = LiveQuery<any, any, any>;

export class LiveQuery<
  E extends EntityDef,
  Sel,
  K extends (keyof E & string) | undefined = undefined,
> {
  #client: TripleClient;
  /** The built query — read by the client's eviction sweep (§7.6). */
  readonly query: QueryBuilder<E, Sel, K>;
  #predicates: Set<string>;
  #listeners = new Set<(rows: EntityResult<E, Sel>[]) => void>();
  /** Per-row fingerprints from the last run, for identity reuse (§11.4). */
  #rows = new Map<string, { fingerprint: string; row: EntityResult<E, Sel> }>();
  #sequence = "";
  /** §6.6 — the last server fetch filled the window, so more rows may exist. */
  #windowFull = false;
  #refilling = false;

  status: QueryStatus = "loading";
  error?: Error;
  /** Resolves when the first load settles. `await live.ready` before reading `data`. */
  readonly ready: Promise<void>;
  /** Current results. Synchronous, and empty until the first load completes. */
  data: EntityResult<E, Sel>[] = [];

  /**
   * §6.6 — the keyset cursor for the NEXT page: the last row's (order value, id),
   * ready for `.after(live.cursor)`. Undefined while the page is empty, and only
   * on ordered queries — no order, no "after".
   */
  get cursor():
    | (K extends keyof E & string
        ? { value: ValueOfField<E[K]> | null; id: Id }
        : never)
    | undefined {
    const order = this.query.window.order;
    const last = this.data[this.data.length - 1];
    if (order === undefined || last === undefined) return undefined;
    const value = (last as Record<string, unknown>)[resultKey(order.predicate)];
    return { value: value ?? null, id: last.id } as this["cursor"];
  }

  constructor(client: TripleClient, query: QueryBuilder<E, Sel, K>) {
    this.#client = client;
    this.query = query;
    this.#predicates = queryPredicates(toPayload(query));
    // Local-first: whatever the cache holds renders NOW — a hydrated client shows
    // data before (or without) the network. The refresh runs behind it.
    this.rematerialize(true);
    this.ready = this.refresh();
  }

  /** §7.3 — the schema generation changed; only a refresh can help. */
  markOutdated(): void {
    this.status = "outdated";
    this.#emit();
  }

  /** Re-fetch from the server. Called once on creation, and on epoch resync. */
  async refresh(): Promise<void> {
    if (this.status === "outdated") return;
    try {
      await this.#client.load(this.query);
      this.status = "ready";
      this.error = undefined;
      // load() notifies every affected query, including this one, but a query whose
      // result did not change would not have fired — so make sure we settle.
      this.rematerialize(true);
    } catch (cause) {
      this.status = cause instanceof SchemaMismatchError ? "outdated" : "error";
      this.error = cause instanceof Error ? cause : new Error(String(cause));
      this.#emit();
    }
  }

  /** Does this delta's predicate set overlap ours? (SPEC §6.4) */
  affectedBy(predicates: ReadonlySet<string>): boolean {
    for (const predicate of this.#predicates) {
      if (predicates.has(predicate)) return true;
    }
    return false;
  }

  /**
   * Re-run against the local cache and notify if the result actually changed.
   *
   * Rows keep their OBJECT IDENTITY across runs when their content is unchanged
   * (§11.4): a UI keyed by row can `===`-skip untouched rows, so one todo's edit
   * re-renders one todo. Change detection is per-row fingerprints plus the row
   * sequence; real incremental maintenance is still deferred (SPEC §11.1).
   */
  rematerialize(force = false): void {
    const fresh = this.#client.run(this.query);
    const rows = new Map<string, { fingerprint: string; row: EntityResult<E, Sel> }>();
    const sequence: string[] = [];
    const next: EntityResult<E, Sel>[] = [];

    for (const row of fresh) {
      const fingerprint = JSON.stringify(row);
      const previous = this.#rows.get(row.id);
      const kept = previous && previous.fingerprint === fingerprint ? previous.row : row;
      rows.set(row.id, { fingerprint, row: kept });
      sequence.push(row.id + "\u0000" + fingerprint);
      next.push(kept);
    }

    const signature = sequence.join("\n");
    const changed = signature !== this.#sequence;
    this.#rows = rows;
    this.#sequence = signature;

    // §6.6 — a live WINDOW refills itself: when rows fall out (a delete, an edit
    // that re-sorts them away) the local cache cannot know what comes next, so if
    // the server's last answer filled the window, ask again.
    const limit = this.query.window.limit;
    if (force) this.#windowFull = limit !== undefined && next.length >= limit;
    else if (
      limit !== undefined &&
      next.length < limit &&
      this.#windowFull &&
      this.status === "ready" &&
      !this.#refilling
    ) {
      this.#refilling = true;
      void this.refresh().finally(() => (this.#refilling = false));
    }

    if (!force && !changed) return;
    this.data = next;
    this.#emit();
  }

  /** Called on every change, and once as soon as the first load lands. */
  subscribe(listener: (rows: EntityResult<E, Sel>[]) => void): () => void {
    this.#listeners.add(listener);
    if (this.status === "ready") listener(this.data);
    return () => this.#listeners.delete(listener);
  }

  /** Stop watching. The client may then evict triples nothing else needs. */
  close(): void {
    this.#listeners.clear();
    this.#client.release(this as AnyLiveQuery);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.data);
  }
}
