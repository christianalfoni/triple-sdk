/**
 * The server half of the SDK.
 *
 * Deliberately transport-agnostic: it takes a message in and gives a message back.
 * Whether those arrive over HTTP, a WebSocket, or a function call in a test is not
 * its problem — see ./http.ts for the Node HTTP binding.
 */

import type { AppSchema, Schema } from "../shared/schema.ts";
import { MemoryStorage, type StorageAdapter } from "../shared/storage.ts";
import { collectPayloadTriples } from "../shared/query.ts";
import { compileOperations, Transaction } from "../shared/transaction.ts";
import {
  canSeeSubject,
  checkWrite,
  createFilterFactory,
  createReadFilter,
  type Policy,
} from "./policy.ts";
import type { Id } from "../shared/types.ts";
import {
  SchemaMismatchError,
} from "../shared/protocol.ts";
import type {
  AckMessage,
  QueryMessage,
  QueryResultMessage,
  RejectMessage,
  StreamMessage,
  TransactMessage,
} from "../shared/protocol.ts";
import { withDelta } from "../shared/store.ts";
import type { Delta, Readable, Triple } from "../shared/types.ts";
import { tripleKey } from "../shared/value.ts";

export type TripleServerOptions = {
  /** The app's schema — `Schema.build({...})`, the same object clients hold. */
  schema: AppSchema;
  /**
   * The access rules, assembled by `Policy.build(schema, { … })` from one
   * `Policy.from(Entity, …)` per entity (SPEC §10) — coverage is checked there,
   * at compile time. Omit for a wide-open dev server. Clients never see rules.
   */
  policy?: Policy;
  /** Defaults to in-memory. Swap for SQLite/Postgres behind the same interface (§5). */
  storage?: StorageAdapter;
  /**
   * The server's history+policy generation (SPEC §7.3). Clients that reconnect and
   * see a different epoch drop their cache and re-query. Defaults to process start,
   * so a restarted in-memory server (reseeded, versions reset) or a policy deploy
   * never leaves reconnecting clients on stale data. Pin it explicitly when the
   * storage is durable and the policy unchanged.
   */
  epoch?: number;
  /**
   * Prior schema generations this build still serves correctly (§7.3) — the expand
   * phase of a migration lists the pre-expand hash here so already-deployed clients
   * keep working; the contract phase drops it, freezing the stragglers. Empty means
   * hard-freeze on any change. The migration actor knows what broke; this is where
   * they say so.
   */
  compatibleSchemas?: string[];
  /**
   * §7.3 — the compaction POLICY: keep at least this many log entries; older ones
   * are forgotten once per that many commits. The store is the snapshot, so
   * compaction never loses data — only replayability: a subscriber whose cursor
   * predates the floor gets `resync` and re-queries from state (built, §7.4).
   * Omit to retain the full log. Meaningless without an adapter `compact`.
   */
  retainLog?: number;
};

type Subscriber = {
  actor: Id;
  send: (message: StreamMessage) => void;
};

export class TripleServer {
  /** The flat predicate map (`"todo/text" → Field`) the runtime layers consume. */
  readonly schema: Schema;
  readonly storage: StorageAdapter;
  readonly policy?: Policy;

  readonly epoch: number;
  /** This build's schema generation (§7.3). */
  readonly schemaHash: string;
  /** Generations this build accepts: its own plus `compatibleSchemas`. */
  readonly acceptedSchemas: ReadonlySet<string>;

  readonly #subscribers = new Set<Subscriber>();
  /** Per entity name, the predicates of its required fields (§4.5). */
  readonly #required = new Map<string, string[]>();
  readonly #retainLog: number | undefined;

  constructor(options: TripleServerOptions) {
    const app = options.schema;
    if (options.policy && options.policy.app !== app) {
      throw new Error(
        "This policy was built from a DIFFERENT schema — Policy.build(schema, …) " +
          "must be given the same schema object this server runs.",
      );
    }
    this.schema = app.flat;
    this.policy = options.policy;
    this.storage = options.storage ?? new MemoryStorage();
    this.#retainLog = options.retainLog;
    this.epoch = options.epoch ?? this.storage.epoch ?? Date.now();
    this.schemaHash = app.hash;
    this.acceptedSchemas = new Set([this.schemaHash, ...(options.compatibleSchemas ?? [])]);

    for (const [name, entity] of Object.entries(app.entities)) {
      const required = Object.entries(entity)
        .filter(([, builder]) => !builder.field.multiple && !builder.field.optional)
        .map(([field]) => `${name}/${field}`);
      this.#required.set(name, required);
    }
  }

  /**
   * SPEC §7.5 — answer a query with the triples needed to evaluate it locally,
   * filtered to what this actor may read (§10).
   *
   * The filter is pushed INTO the scan rather than applied to the result, so an
   * entity you cannot see never becomes a root and never leaks through a count.
   */
  query(message: QueryMessage, actor: Id): QueryResultMessage {
    if (!this.acceptedSchemas.has(message.schema)) throw new SchemaMismatchError();
    const canRead = this.policy
      ? createReadFilter(this.storage, this.policy, actor)
      : undefined;

    return {
      kind: "queryResult",
      version: this.storage.version,
      triples: collectPayloadTriples(this.storage, message.payload, canRead),
    };
  }

  /**
   * SPEC §7.2 — server authority. The client proposes; we decide.
   *
   * `actor` is supplied by the transport, which authenticated the connection — it
   * is NOT read off the message, because the client controls that (SPEC §7.4).
   */
  transact(message: TransactMessage, actor: Id): AckMessage | RejectMessage {
    if (!this.acceptedSchemas.has(message.schema)) {
      return {
        kind: "reject",
        mutationId: message.mutationId,
        reason: new SchemaMismatchError().message,
      };
    }
    let delta, deleted;
    try {
      // SPEC §9.1 — the wire carried intent; compile it against the truth.
      ({ delta, deleted } = compileOperations(this.storage, this.schema, message.operations));
    } catch (cause) {
      return {
        kind: "reject",
        mutationId: message.mutationId,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    if (this.policy) {
      // Checked AFTER §9.1 normalization, so the server-derived removes are
      // authorized too. Per subject, per verb, all-or-nothing (§10.4).
      const reason = checkWrite(this.storage, this.policy, actor, delta, deleted);
      if (reason) {
        return { kind: "reject", mutationId: message.mutationId, reason };
      }
    }

    {
      // §4.5 — required fields are a schema guarantee, so the types can claim
      // presence. Enforced here, after authorization, even with no policy set.
      const reason = this.#checkRequired(delta);
      if (reason) {
        return { kind: "reject", mutationId: message.mutationId, reason };
      }
    }

    const fanOut = this.#prepareFanOut(delta, actor);

    const entry = this.storage.apply(delta, actor);
    if (entry) this.#compactIfDue(entry.version);

    if (!entry) {
      // Nothing changed — every added triple was already present and every removed
      // one already absent. Still an ack: from the client's point of view its
      // intent holds, so it should drop the pending delta (SPEC §8.2).
      return {
        kind: "ack",
        mutationId: message.mutationId,
        version: this.storage.version,
        delta: { added: [], removed: [] },
      };
    }

    this.#send(fanOut.subscribers, entry.version, actor);

    // The ack's delta is the AUTHOR's visible view, including any visibility diffs
    // their own write caused (§10.6) — give an entity away and the ack carries the
    // removes that clean it out of your own cache.
    return {
      kind: "ack",
      mutationId: message.mutationId,
      version: entry.version,
      delta: fanOut.ackDelta ?? entry.delta,
    };
  }

  /**
   * SPEC §7.7 — register a live subscriber. Every committed delta is pushed to it,
   * filtered to what its actor may read. With `since` set, the log backlog after
   * that version is replayed first (§7.3) — filtered against the CURRENT state,
   * which is the best a replay can do (§10.6).
   */
  subscribe(
    actor: Id,
    send: (message: StreamMessage) => void,
    since?: number,
  ): () => void {
    const subscriber: Subscriber = { actor, send };
    const firstOfActor = ![...this.#subscribers].some((s) => s.actor === actor);
    this.#subscribers.add(subscriber);

    // §7.3 — HELLO IS ALWAYS FIRST on a stream: the epoch/schema handshake must be
    // settled before anything else is interpreted.
    send({
      kind: "hello",
      epoch: this.epoch,
      version: this.storage.version,
      schema: this.schemaHash,
      compatible: [...this.acceptedSchemas],
    });

    // §13 — the newcomer gets the roster once; everyone else gets an O(1) diff.
    send({ kind: "presence", online: this.#online() });
    if (firstOfActor) {
      for (const other of this.#subscribers) {
        if (other !== subscriber) other.send({ kind: "presence", joined: actor });
      }
    }

    if (since !== undefined) {
      const entries = this.storage.entriesSince(since);
      if (entries === null) {
        // §7.3 — the cursor predates the retention floor. The gap cannot be
        // replayed, so the client must rebuild from state.
        send({ kind: "resync" });
        return () => this.#unsubscribe(subscriber);
      }
      const canRead = this.policy
        ? createReadFilter(this.storage, this.policy, actor)
        : undefined;
      for (const entry of entries) {
        send({
          kind: "delta",
          version: entry.version,
          actor: entry.actor,
          delta: canRead
            ? {
                added: entry.delta.added.filter(canRead),
                removed: entry.delta.removed.filter(canRead),
              }
            : entry.delta,
        });
      }

      // §10.6 — visibility REPAIR: the backlog above was filtered by CURRENT
      // readability, so a policy change that happened while this client was
      // away is invisible in it (it may not even see the revoking triple). Walk
      // the backlog's policy-relevant subjects once: now-invisible ones are
      // EVICTED by id (ids only — the values may no longer be its to see);
      // still-visible ones get their current readable triples re-sent, which an
      // up-to-date cache absorbs as no-ops. Idempotent by construction.
      if (this.policy && canRead && entries.length > 0) {
        const aggregate = {
          added: entries.flatMap((entry) => entry.delta.added),
          removed: entries.flatMap((entry) => entry.delta.removed),
        };
        const evict: Id[] = [];
        const refresh: Triple[] = [];
        for (const subject of this.#affectedSubjects(aggregate, this.storage)) {
          if (canSeeSubject(this.storage, this.policy, actor, subject)) {
            for (const triple of this.storage.match([subject, undefined, undefined])) {
              if (canRead(triple)) refresh.push(triple);
            }
          } else {
            evict.push(subject);
          }
        }
        if (evict.length > 0 || refresh.length > 0) {
          send({ kind: "repair", evict, refresh: { added: refresh, removed: [] } });
        }
      }
    }

    return () => this.#unsubscribe(subscriber);
  }

  #online(): Id[] {
    return [...new Set([...this.#subscribers].map((s) => s.actor))];
  }

  #unsubscribe(subscriber: Subscriber): void {
    this.#subscribers.delete(subscriber);
    const lastOfActor = ![...this.#subscribers].some((s) => s.actor === subscriber.actor);
    if (lastOfActor) {
      for (const other of this.#subscribers) {
        other.send({ kind: "presence", left: subscriber.actor });
      }
    }
  }

  /**
   * SPEC §13 — fan an ephemeral payload. Never logged, never versioned. With
   * `about`, only subscribers whose read policy admits that subject receive it —
   * transient activity honors the same visibility as the data it concerns.
   */
  broadcast(actor: Id, payload: unknown, about?: Id): void {
    const visible =
      about !== undefined && this.policy
        ? (subscriberActor: Id) =>
            canSeeSubject(this.storage, this.policy!, subscriberActor, about)
        : () => true;
    const verdicts = new Map<Id, boolean>();
    for (const subscriber of this.#subscribers) {
      let ok = verdicts.get(subscriber.actor);
      if (ok === undefined) verdicts.set(subscriber.actor, (ok = visible(subscriber.actor)));
      if (ok) subscriber.send({ kind: "ephemeral", actor, payload });
    }
  }

  /**
   * §4.5 — no surviving subject may be left without a required field.
   *
   * Covers creates that omit one, updates that remove one, AND deletes of an entity
   * that something else required a ref to — referential integrity as a side effect
   * (delete a user and any todo still requiring `owner` blocks it: reassign or
   * delete the todos first). A fully deleted subject is exempt. `commit()` bypasses
   * this like everything else — migrations need to write transitional states.
   */
  #checkRequired(delta: Delta): string | null {
    const after = withDelta(this.storage, delta);
    const seen = new Set<string>();

    for (const [subject, predicate] of [...delta.removed, ...delta.added]) {
      const slash = predicate.indexOf("/");
      const entityName = slash === -1 ? "" : predicate.slice(0, slash);
      const key = `${subject}|${entityName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const required = this.#required.get(entityName);
      if (!required || required.length === 0) continue;
      if (after.match([subject, undefined, undefined]).length === 0) continue;

      for (const requiredPredicate of required) {
        if (after.match([subject, requiredPredicate, undefined]).length === 0) {
          return `"${requiredPredicate}" is required — ${subject} cannot be left without it.`;
        }
      }
    }
    return null;
  }

  /**
   * Everything the fan-out needs, computed BEFORE the delta is applied.
   *
   * Per subscriber (§7.7): the delta's own triples — removed filtered by the
   * pre-state, added by the post-state — plus the §10.6 visibility diffs for every
   * subject whose policy context this delta touches.
   *
   * Three layers of sharing keep this O(distinct actors), not O(subscribers):
   * policy CONTEXTS are actor-independent, so one filter factory per state shares
   * one context cache across all actors; the per-subject before/after triple
   * lists are computed once; and the final visible delta is memoized per AUTHOR —
   * five hundred subscribers signed in as twenty users cost twenty evaluations.
   */
  #prepareFanOut(
    delta: Delta,
    ackActor?: Id,
  ): { subscribers: [Subscriber, Delta][]; ackDelta?: Delta } {
    if (!this.policy) {
      return {
        subscribers: [...this.#subscribers].map((subscriber) => [subscriber, delta]),
        ...(ackActor !== undefined ? { ackDelta: delta } : {}),
      };
    }

    const post = withDelta(this.storage, delta);
    const affected = this.#affectedSubjects(delta, post);

    // Shared across every actor: filter factories (one fields cache per state)…
    const preFilterFor = createFilterFactory(this.storage, this.policy);
    const postFilterFor = createFilterFactory(post, this.policy);
    // …and the affected subjects' triples, listed once.
    const subjectTriples = [...affected].map((subject) => ({
      before: this.storage.match([subject, undefined, undefined]),
      after: post.match([subject, undefined, undefined]),
    }));

    const byActor = new Map<Id, Delta>();
    const visible = (actor: Id): Delta => {
      const cached = byActor.get(actor);
      if (cached) return cached;

      const preFilter = preFilterFor(actor);
      const postFilter = postFilterFor(actor);

      const added = new Map<string, Triple>();
      const removed = new Map<string, Triple>();
      for (const triple of delta.added) {
        if (postFilter(triple)) added.set(tripleKey(triple), triple);
      }
      for (const triple of delta.removed) {
        if (preFilter(triple)) removed.set(tripleKey(triple), triple);
      }

      for (const { before, after } of subjectTriples) {
        const visibleBefore = new Map(
          before.filter(preFilter).map((t) => [tripleKey(t), t] as const),
        );
        const visibleAfter = new Map(
          after.filter(postFilter).map((t) => [tripleKey(t), t] as const),
        );
        for (const [key, t] of visibleBefore) if (!visibleAfter.has(key)) removed.set(key, t);
        for (const [key, t] of visibleAfter) if (!visibleBefore.has(key)) added.set(key, t);
      }

      const result = { added: [...added.values()], removed: [...removed.values()] };
      byActor.set(actor, result);
      return result;
    };

    return {
      subscribers: [...this.#subscribers].map((subscriber) => [
        subscriber,
        visible(subscriber.actor),
      ]),
      ...(ackActor !== undefined ? { ackDelta: visible(ackActor) } : {}),
    };
  }

  /**
   * §10.6 — which subjects' VISIBILITY may this delta change?
   *
   * For each touched predicate, the policy's dependency map lists the ref paths
   * from a context root to that predicate. The empty path means the triple's own
   * subject; a non-empty one is walked BACKWARDS through the ref triples (in both
   * pre- and post-state, since the delta may add or remove the refs themselves).
   */
  #affectedSubjects(delta: Delta, post: Readable): Set<Id> {
    const affected = new Set<Id>();
    if (!this.policy) return affected;

    for (const [subject, predicate] of [...delta.added, ...delta.removed]) {
      const paths = this.policy.dependencies.get(predicate);
      if (!paths) continue;
      for (const path of paths) {
        let level = new Set<Id>([subject]);
        for (let i = path.length - 1; i >= 0; i--) {
          const refPredicate = path[i]!;
          const next = new Set<Id>();
          for (const mid of level) {
            for (const [s] of this.storage.match([undefined, refPredicate, { id: mid }]))
              next.add(s);
            for (const [s] of post.match([undefined, refPredicate, { id: mid }]))
              next.add(s);
          }
          level = next;
        }
        for (const root of level) affected.add(root);
      }
    }
    return affected;
  }



  /** Build a delta against server state — used for seeding (see demo/server/seed.ts). */
  transaction(): Transaction {
    return new Transaction(this.schema, this.storage);
  }

  /**
   * Commit a transaction directly, bypassing the wire — and therefore bypassing
   * both §9.1 and the policy (§10). Server-side writes only: seeding, migrations,
   * background jobs. Anything originating from a client must go through `transact`,
   * where the actor comes from the authenticated connection (§7.4).
   *
   * There is no connection here to derive an actor from, so the log records the
   * server itself — `"system"` — unless the write should be attributed differently.
   */
  commit(transaction: Transaction, actor: Id = "system") {
    // Server-side transactions read the LIVE store, so their compiled delta is
    // already authoritative — no re-compile needed on this trusted path.
    const { delta } = transaction.build();
    // Write checks are bypassed — this is the server — but fan-out READ filtering
    // is not (§7.7): a migration or seed reaches every subscriber, each seeing only
    // what they may. This is what makes a data migration land live on connected
    // clients instead of waiting for their next reconnect.
    const fanOut = this.#prepareFanOut(delta);
    const entry = this.storage.apply(delta, actor);
    if (entry) {
      this.#compactIfDue(entry.version);
      this.#send(fanOut.subscribers, entry.version, actor);
    }
    return entry;
  }

  /**
   * §7.3 — opportunistic compaction: once every `retainLog` commits, forget
   * everything older than the last `retainLog` entries. Deterministic (a pure
   * function of version), so restarts change nothing.
   */
  #compactIfDue(version: number): void {
    const retain = this.#retainLog;
    if (retain === undefined || !this.storage.compact) return;
    if (version % retain === 0) this.storage.compact(version - retain);
  }

  #send(outgoing: [Subscriber, Delta][], version: number, actor: Id): void {
    for (const [subscriber, visible] of outgoing) {
      subscriber.send({ kind: "delta", version, actor, delta: visible });
    }
  }
}
