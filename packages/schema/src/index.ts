/**
 * The workspace's SHAPE — shared by app and worker (§10.1: the schema module is
 * pure shape; policy lives server-side in the worker, importing this, never the
 * reverse — the trust boundary made a package boundary).
 *
 * The product bet: every todo is PRIVATE to its owner unless `shared` — and
 * flipping `shared` off is a live revocation (§10.6): other members watch it
 * vanish in real time.
 */
import { Schema } from "triple-sdk/schema";

export const User = Schema.from({
  name: Schema.string(),
  email: Schema.string().optional(),
});

export const Todo = Schema.from({
  text: Schema.string(),
  completed: Schema.boolean(),
  /** false = only the owner's; true = on the workspace board. */
  shared: Schema.boolean(),
  owner: Schema.ref(User),
  /** §4.7 — x and y change together; the object value keeps them atomic. */
  position: Schema.object({ x: Schema.number(), y: Schema.number() }).optional(),
  tags: Schema.string().multiple(),
});

export const schema = Schema.build({ user: User, todo: Todo });
