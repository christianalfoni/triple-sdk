/**
 * SPEC §7.1 — Wire protocol.
 */

import type { QueryPayload } from "./query.ts";
import type { Delta, Id, Triple, Value } from "./types.ts";

/**
 * SPEC §9.1 — the wire carries INTENT; the log carries materialized deltas.
 *
 * The client does not compile "set text" into remove+add pairs for the server —
 * its cache is partial, so its view of the "old value" cannot be trusted anyway.
 * It states what it means; the server compiles that against the truth. `delete`
 * exists here precisely because a triple delta cannot express it: the client
 * cannot enumerate inbound refs it never synced.
 */
export type Operation =
  | { op: "set"; subject: Id; predicate: string; value: Value }
  | { op: "add"; subject: Id; predicate: string; value: Value }
  | { op: "remove"; subject: Id; predicate: string; value: Value }
  | { op: "delete"; subject: Id };

// --- Client -> Server --------------------------------------------------------

/**
 * Propose a delta. `mutationId` is client-generated and echoed back in ack/reject so
 * the client can match the response to its pending mutation (§8.2).
 *
 * Note what is NOT here: who is writing. Identity comes from the authenticated
 * connection, never from the message body — see SPEC §7.4.
 */
/** Ask for everything needed to answer this query. */
export type QueryMessage = {
  kind: "query";
  /** The client's schema generation (§7.3). Mismatch → the request is refused. */
  schema: string;
  payload: QueryPayload;
};

export type TransactMessage = {
  kind: "transact";
  /** The client's schema generation (§7.3). Mismatch → the request is refused. */
  schema: string;
  mutationId: string;
  operations: Operation[];
};

// --- Server -> Client --------------------------------------------------------

/**
 * The triples needed to answer a query locally (SPEC §7.5).
 *
 * Not the materialized result: the client applies these to its own store and then
 * runs the same executor, which is why a local write can update the result without
 * another round trip.
 */
export type QueryResultMessage = {
  kind: "queryResult";
  version: number;
  triples: Triple[];
};

/** The proposed delta was committed. The client drops it from `pending` (§8.2). */
export type AckMessage = {
  kind: "ack";
  mutationId: string;
  version: number;
  /** The EFFECTIVE delta — may be smaller than proposed if some triples existed. */
  delta: Delta;
};

/** The proposed delta was refused. The client drops it from `pending` (§8.2). */
export type RejectMessage = {
  kind: "reject";
  mutationId: string;
  reason: string;
};

/**
 * One committed change, pushed to a subscriber (SPEC §7.7). Filtered per subscriber:
 * added triples against the post-state, removed against the pre-state — you are told
 * about removals of what you COULD see, additions of what you CAN see.
 *
 * `version` is the dedupe cursor: a client skips any delta at or below its own.
 */
export type DeltaMessage = {
  kind: "delta";
  version: number;
  actor: Id;
  delta: Delta;
};

/**
 * First message on every stream (SPEC §7.3). `epoch` identifies the server's
 * history+policy generation: a client that reconnects and sees a different epoch
 * cannot trust its cache — the store may have been reseeded or the policy
 * redeployed — so it drops everything and re-runs its queries.
 */
export type HelloMessage = {
  kind: "hello";
  epoch: number;
  version: number;
  /** The server's schema generation — a client on a different one must freeze… */
  schema: string;
  /** …unless its generation is in this accepted list (§7.3, migrations). */
  compatible?: string[];
};

/**
 * "Your cursor predates what the log retains — I cannot replay your gap"
 * (SPEC §7.3). Same epoch, same history, but the middle is compacted away, so the
 * client must fall back to state: drop the cache and re-run its queries.
 */
export type ResyncMessage = {
  kind: "resync";
};

/**
 * SPEC §13 — the ephemeral lane. Rides the same stream as deltas but is NEVER
 * logged and NEVER versioned: cursors, drags-in-progress, typing previews. Lossy
 * by design — a client that missed one loses nothing durable, and the next commit
 * (or the next broadcast) supersedes it.
 */
export type EphemeralMessage = {
  kind: "ephemeral";
  actor: Id;
  payload: unknown;
};

/**
 * SPEC §13 — presence. The full roster travels ONCE per stream (right after
 * `hello`); every change after that is an O(1) diff. A join storm costs each
 * subscriber one small message per event, not the roster squared.
 */
export type PresenceMessage = {
  kind: "presence";
  online?: Id[];
  joined?: Id;
  left?: Id;
};

/**
 * C → S: fan `payload` ephemerally. With `about`, only subscribers who may READ
 * that subject receive it — a drag preview of a private todo does not leak its
 * activity to people the policy hides the todo from (§13).
 */
export type BroadcastMessage = {
  kind: "broadcast";
  payload: unknown;
  about?: Id;
};

/** Everything the server can push down a stream. */
export type StreamMessage =
  | HelloMessage
  | DeltaMessage
  | ResyncMessage
  | RepairMessage
  | EphemeralMessage
  | PresenceMessage;

/**
 * §10.6 — visibility repair on CATCH-UP. Backlog replay cannot reconstruct
 * pre-states, so a reconnecting client that missed a same-epoch policy change
 * gets this after its backlog: `evict` names subjects now INVISIBLE to it (ids
 * only — never the values, which it may no longer read); `refresh` carries the
 * current readable triples of affected subjects still (or newly) visible.
 * Idempotent: applying it twice changes nothing.
 */
export type RepairMessage = {
  kind: "repair";
  evict: Id[];
  refresh: Delta;
};

/** Thrown/returned when the caller's schema generation is not accepted (§7.3). */
export class SchemaMismatchError extends Error {
  constructor() {
    super("The server is running a different schema generation — refresh to continue.");
    this.name = "SchemaMismatchError";
  }
}
