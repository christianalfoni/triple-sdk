import type { TripleServer } from "../../sdk/server/server.ts";
import { DEMO_TEAM, DEMO_USER, OTHER_USER, Team, Todo, User } from "../shared/schema.ts";

export function seed(server: TripleServer): void {
  const tx = server.transaction();

  tx.edit(User, DEMO_USER).name = "Christian";
  tx.edit(User, OTHER_USER).name = "Ada";

  tx.edit(Team, DEMO_TEAM).name = "Platform";
  tx.edit(Team, DEMO_TEAM).member.push({ id: DEMO_USER });
  tx.edit(Team, DEMO_TEAM).member.push({ id: OTHER_USER });

  tx.create(Todo, {
    text: "Understand what a triple is",
    completed: true,
    owner: { id: DEMO_USER },
    tags: ["rdf", "basics"],
  });

  tx.create(Todo, {
    text: "Build the query engine",
    completed: false,
    owner: { id: DEMO_USER },
    tags: ["sdk"],
    position: { x: 120, y: 80 },
  });

  tx.create(Todo, {
    text: "Decide on the traversal design",
    completed: false,
    owner: { id: OTHER_USER },
    team: { id: DEMO_TEAM },
  });

  tx.create(Todo, {
    text: "Ada's private todo",
    completed: false,
    owner: { id: OTHER_USER },
  });

  server.commit(tx);
}
