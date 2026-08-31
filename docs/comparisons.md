# How it compares

Honest positioning against the systems that shipped this shape (2025–26). Every row
is a different answer to one question: _what is the unit of fan-out?_

|                 | Unit of sync                                               | Permissions                                            | Writes                                                         | Where it wins                                                                                   |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **This SDK**    | the query, per-reader filtered                             | per-triple, in the scan; revocation arrives as a delta | owned end-to-end: intent ops, optimistic layers, offline queue | workspace products: private-by-row data inside shared spaces, one integrated contract           |
| **ElectricSQL** | the shape (table + WHERE), identical bytes for all readers | at the shape boundary, via your proxy                  | none — bring your own API; Electric tails the WAL              | shared data to unlimited readers: CDN does the fan-out (1M clients, flat latency)               |
| **Zero**        | synced queries with server permissions + IVM               | declarative, server-evaluated                          | custom mutators                                                | instant local reads at scale; closest cousin to this design                                     |
| **Replicache**  | key-value spaces, poke + pull                              | in your push endpoint                                  | mutation replay (the pattern our outbox borrows)               | the proven minimal loop; predecessor to Zero                                                    |
| **InstantDB**   | triple queries (InstaQL) on one shared cloud DB            | rule expressions                                       | transactions with optimistic apply                             | the same triple bet, as a hosted platform — one DB for every app is what makes free tiers cheap |
| **Yjs / CRDTs** | the document                                               | none — whole doc or nothing                            | merge functions, character-level                               | collaborative TEXT — the one thing per-field LWW cannot do (our ledgered boundary)              |

The core fork: **per-reader streams (us, Zero) cannot be CDN-cached; cacheable
streams (Electric) cannot carry per-row privacy.** Audience logs — partitioning
streams by policy-derived audience — are the ledgered bridge (SPEC §11.1).
Electric's own history is the cautionary tale worth knowing: it began as a full
local-first framework like this one and retreated to read-path-only sync in 2024 —
adoption beat integration. This repo keeps the full contract because it exists to
understand it.
