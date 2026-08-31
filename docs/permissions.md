# Permissions — filtered inside the scan, moving as data

Two commitments define this layer. **Server-only**: clients never see rules and
never need them — what they receive is already filtered (a policy usually
references data the client does not have, so client-side evaluation would not
merely be untrusted, it would be wrong). **Inside the scan**: filtering happens
as triples are read, never on results — post-hoc filtering leaks through
counts, joins and windows; in-scan filtering makes an invisible row
indistinguishable from an absent one (§0.3, §10.5).

## One policy per entity, one rule per verb

```ts
export const todoPolicy = Policy.from(Todo, {
  fields: { owner: true, team: { member: true } },  // what the rules get to SEE
  read:   (ctx) => ctx.fields.owner?.id === ctx.actor ||
                   ctx.fields.team?.member.some((m) => m.id === ctx.actor),
  create: (ctx) => ctx.fields.owner?.id === ctx.actor,  // fields = ONCE IT LANDS
  update: (ctx) => ctx.fields.owner?.id === ctx.actor,  // fields = as it is now
  delete: (ctx) => ctx.fields.owner?.id === ctx.actor,
  overrides: {
    completed: { write: (ctx) => /* mates may toggle */ ... },
  },
});

export const policy = Policy.build(schema, { user: userPolicy, team: teamPolicy, todo: todoPolicy });
new TripleServer({ schema, policy });
```

- **Deny by default, enforced by types.** `Policy.build` requires a key per
  entity — omitting one is a missing-property compile error. A rule must define
  every verb. A check returning `undefined` (an optional chain that hit
  nothing) DENIES: only an explicit `true` grants.
- **Each verb sees the state where the entity exists** (§10.4): create sees the
  landing state (there is no pre-state), delete sees the current one, update
  sees both (`ctx.fields` + `ctx.after`) — pre-only cannot validate what lands;
  post-only lets anyone seize ownership.
- **Per-field `overrides`** replace the entity rule for that field alone —
  `read` filters its triples, `write` decides its changes on create/update
  (delete stays entity-level: not a field-sized decision).

## Why `fields` is declared data

The declaration is the engine's leverage: fields load once per subject (not per
triple), bulk-preload across subjects, share one cache across every actor in a
fan-out — and, crucially, they make the **visibility dependency graph static**:
the server knows which writes change whose visibility.

That is what buys revocation-as-data (§10.6): remove someone from a team and
synthesized removal deltas reach them in ~22ms while teammates see only the
membership change — and a client that was OFFLINE for the revocation heals at
reconnect via `repair` ([recovery](./recovery.md)).

## The fork we measured and declined

Rules here are lambdas, only. A declarative expression form was fully built on
this codebase — typed paths, self-deriving fields, visible-set compilation
(~35% on adversarial scans, ~0% on realistic reads) — and removed: two rule
languages mix badly, and the wins that matter (policy as scan constraints,
audience-partitioned fan-out, CDN reads) demand declarative-ONLY, which is a
different system. SPEC §10.7 records the whole argument with numbers — read it
before re-having this debate.

Deep dive: SPEC §10 (all of it).
