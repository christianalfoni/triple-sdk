import { newId } from "../../sdk/shared/transaction.ts";
import type { TripleServer } from "../../sdk/server/server.ts";
import { DEMO_TEAM, DEMO_USER, OTHER_USER, Team, Todo, User } from "../shared/schema.ts";

export function seed(server: TripleServer): void {
  const tx = server.transaction();

  tx.set(User, DEMO_USER, "name", "Christian");
  tx.set(User, OTHER_USER, "name", "Ada");

  tx.set(Team, DEMO_TEAM, "name", "Platform");
  tx.add(Team, DEMO_TEAM, "member", { id: DEMO_USER });
  tx.add(Team, DEMO_TEAM, "member", { id: OTHER_USER });

  const learn = newId("todo");
  tx.set(Todo, learn, "text", "Understand what a triple is");
  tx.set(Todo, learn, "completed", true);
  tx.set(Todo, learn, "owner", { id: DEMO_USER });
  tx.add(Todo, learn, "tags", "rdf");
  tx.add(Todo, learn, "tags", "basics");

  const engine = newId("todo");
  tx.set(Todo, engine, "text", "Build the query engine");
  tx.set(Todo, engine, "completed", false);
  tx.set(Todo, engine, "owner", { id: DEMO_USER });
  tx.add(Todo, engine, "tags", "sdk");

  const shared = newId("todo");
  tx.set(Todo, shared, "text", "Decide on the traversal design");
  tx.set(Todo, shared, "completed", false);
  tx.set(Todo, shared, "owner", { id: OTHER_USER });
  tx.set(Todo, shared, "team", { id: DEMO_TEAM });

  const hidden = newId("todo");
  tx.set(Todo, hidden, "text", "Ada's private todo");
  tx.set(Todo, hidden, "completed", false);
  tx.set(Todo, hidden, "owner", { id: OTHER_USER });

  server.commit(tx);
}
