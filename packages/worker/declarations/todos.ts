/**
 * The todo board's schema, AS A DECLARATION — the same entity and the same
 * rules this repo proved the SDK with, now data a workspace admin (or an
 * agent) sets over MCP. The seed declares it for the dev workspace; the
 * service smoke declares it and then exercises every rule through it.
 */
import type { WorkspaceDeclaration } from "workspace-platform";

const mine = { equals: ["fields.owner", "actor"] } as const;
const onTheBoard = {
  allOf: [{ equals: ["fields.shared", true] }, { in: ["actor.role", ["admin", "member"]] }],
} as const;

export const todos: WorkspaceDeclaration = {
  entities: {
    todo: {
      fields: {
        text: "string",
        completed: "boolean",
        shared: "boolean",
        owner: { ref: "user" },
        position: { object: { x: "number", y: "number" }, optional: true },
        tags: { type: "string", multiple: true },
      },
      rules: {
        // Yours, or on the board — and the board is for members.
        read: { anyOf: [mine, onTheBoard] },
        create: mine,
        update: mine,
        delete: mine,
        // The collaborative exception: anyone who can SEE a shared todo may tick it.
        overrides: { completed: { write: { anyOf: [mine, onTheBoard] } } },
      },
    },
  },
};
