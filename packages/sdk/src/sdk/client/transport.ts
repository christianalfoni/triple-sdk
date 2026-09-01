/**
 * How the client talks to the server. One interface, so realtime (SPEC §7) is a new
 * implementation rather than a rewrite of TripleClient.
 */

import {
  SchemaMismatchError,
  type AckMessage,
  type BroadcastMessage,
  type QueryMessage,
  type QueryResultMessage,
  type RejectMessage,
  type StreamMessage,
  type TransactMessage,
} from "../shared/protocol.ts";

export { SchemaMismatchError } from "../shared/protocol.ts";

export interface Transport {
  query(message: QueryMessage): Promise<QueryResultMessage>;
  transact(message: TransactMessage): Promise<AckMessage | RejectMessage>;
  broadcast(message: BroadcastMessage): Promise<void>;
  /**
   * Open a live delta stream (SPEC §7.7). `getSince` is consulted on every
   * (re)connect so a reconnect resumes from the client's current version (§7.3);
   * a client at version 0 subscribes live-only — state comes from queries, not
   * history. Returns a disconnect function.
   */
  deltas(
    getSince: () => number,
    onMessage: (message: StreamMessage) => void,
  ): () => void;
}

/** HTTP for request/response, Server-Sent Events for the delta stream. */
export class HttpTransport implements Transport {
  constructor(
    private readonly baseUrl = "/api",
    /** Sent with every request AND the delta stream — where auth rides. */
    private readonly headers: Record<string, string> = {},
  ) {}

  async query(message: QueryMessage): Promise<QueryResultMessage> {
    const res = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (res.status === 409) throw new SchemaMismatchError();
    if (!res.ok) throw new Error(`query failed: ${res.status}`);
    return (await res.json()) as QueryResultMessage;
  }

  async broadcast(message: BroadcastMessage): Promise<void> {
    await fetch(`${this.baseUrl}/broadcast`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
  }

  async transact(message: TransactMessage): Promise<AckMessage | RejectMessage> {
    const res = await fetch(`${this.baseUrl}/transact`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (res.status === 409) throw new SchemaMismatchError();
    if (!res.ok) throw new Error(`transact failed: ${res.status}`);
    return (await res.json()) as AckMessage | RejectMessage;
  }

  deltas(
    getSince: () => number,
    onMessage: (message: StreamMessage) => void,
  ): () => void {
    let stopped = false;
    let controller = new AbortController();

    const run = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const since = getSince();
          const query = since > 0 ? `?since=${since}` : "";
          const res = await fetch(`${this.baseUrl}/subscribe${query}`, {
            headers: { ...this.headers, accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`subscribe failed: ${res.status}`);

          // Parse the SSE stream by hand: events are separated by a blank line,
          // payloads are `data: ` lines. ~15 lines beats a dependency.
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const event = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              for (const line of event.split("\n")) {
                if (line.startsWith("data: ")) {
                  onMessage(JSON.parse(line.slice(6)) as StreamMessage);
                }
              }
            }
          }
        } catch {
          // Connection lost or aborted — fall through to the retry loop.
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }
}