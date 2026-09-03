/**
 * The workspace's FIXED shape — what every workspace has before it declares
 * anything: its people, and the platform's entities (apps, drafts, releases).
 * Shared by the console and the worker (§10.1: pure shape; the rules live in
 * the platform, server-side).
 *
 * Everything a workspace is ABOUT — its todos, notes, whatever an agent
 * declares — is data (§4.9): declared over MCP, stored in the cell, and served
 * to apps as `/w/<org>/schema.js`. This module's hash is the console's
 * generation; every cell lists it as compatible, because the console only
 * ever touches these fixed entities.
 */
import { Schema } from "triple-sdk/schema";
import { platformEntities, platformUserFields } from "workspace-platform/schema";

/** A member of the workspace — `role` and `email` come from the identity provider (see platformUserFields). */
export const User = Schema.from({
  name: Schema.string(),
  ...platformUserFields,
});

export const platform = platformEntities(User);
export const App = platform.app;
export const DraftFile = platform.draftFile;
export const Release = platform.release;
export const ReleaseFile = platform.releaseFile;

export const schema = Schema.build({ user: User, ...platform });
