// SHAPE ONLY — imported by client AND server. Policy (logic) lives server-side:
// the file boundary is the trust boundary.
//
// Why entities: an entity is just its fields — the NAME is the key in
// Schema.build, written once; wire predicates (todo/text) are generated — and
// Schema.ref(User) carries its target in the TYPE, which is what
// lets queries and policy contexts nest with bare keys and computed result types.
// Why required-by-default: the type claims `string`, and the server enforces it on
// every write — types that cannot lie. Cost of it all: ~500 bytes per triple in
// memory, ~35 bytes serialized.

import { Schema } from "../../sdk/shared/schema.ts";

export const User = Schema.from({
  name: Schema.string(),
});

export const Team = Schema.from({
  name: Schema.string(),
  member: Schema.ref(User).multiple(),
});

export const Todo = Schema.from({
  text: Schema.string(), // required → `string`, no ?? "" anywhere
  completed: Schema.boolean(),
  owner: Schema.ref(User),
  team: Schema.ref(Team).optional(), // private todos have no team → `Ref | undefined`
  tags: Schema.string().multiple(), // → `string[]`, [] when absent
});

// an entity is just its fields — the KEY here is its name (and its id prefix)
export const schema = Schema.build({ user: User, team: Team, todo: Todo });

export const DEMO_USER = "user_christian";
export const OTHER_USER = "user_ada";
export const DEMO_TEAM = "team_platform";
