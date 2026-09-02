/**
 * The platform's SHAPE — the entities every workspace carries so that apps are
 * DATA: a registry row per app, mutable draft files, and immutable releases.
 * Shared by both sides like any schema (§10.1); the rules live in ./policy.ts.
 *
 * A factory rather than constants, because `Release.publishedBy` points at the
 * workspace's own user entity, which the platform does not define. Call it
 * once next to `Schema.build` and spread the result in — the registry keys are
 * fixed ("app", "draftFile", "release", "releaseFile") so the runtime can find
 * them again by name (`platformEntitiesOf`).
 *
 * Why releases are COPIES and not log history: `retainLog` compaction forgets
 * old entries by design, so a published version must survive as state. A
 * release is a pinned set of ReleaseFile rows; "serve version 12" is a query,
 * not a replay. Unchanged files are duplicated across releases on purpose —
 * KB-scale strings in SQLite do not warrant content addressing.
 */
import { Schema, type AppSchema, type EntityDef, type FieldBuilder } from "triple-sdk/schema";

// Type aliases break the App ↔ Release TYPE cycle; the thunk in `live` breaks
// the VALUE cycle (§4.4). Aliases, not interfaces — only aliases carry the
// implicit index signature EntityDef requires.
export type AppFields<U extends EntityDef> = {
  /** The URL segment: apps are served at …/apps/<name>/. */
  name: FieldBuilder<"string", false, false>;
  /** What members see. Absent until the first publish; repointing it IS rollback. */
  live: FieldBuilder<"ref", false, true, ReleaseFields<U>>;
};

export type ReleaseFields<U extends EntityDef> = {
  app: FieldBuilder<"ref", false, false, AppFields<U>>;
  /** 1, 2, 3 … — max + 1 at publish time. */
  version: FieldBuilder<"number", false, false>;
  /** The schema generation (hash) the release was built against — stale apps are detectable. */
  schemaGeneration: FieldBuilder<"string", false, false>;
  publishedBy: FieldBuilder<"ref", false, false, U>;
  publishedAt: FieldBuilder<"number", false, false>;
};

export function platformEntities<U extends EntityDef>(User: U) {
  const App: AppFields<U> = Schema.from({
    name: Schema.string(),
    live: Schema.ref((): ReleaseFields<U> => Release).optional(),
  });

  const Release: ReleaseFields<U> = Schema.from({
    app: Schema.ref(App),
    version: Schema.number(),
    schemaGeneration: Schema.string(),
    publishedBy: Schema.ref(User),
    publishedAt: Schema.number(),
  });

  /** The agent's workbench: write_file edits THESE. One row per (app, path). */
  const DraftFile = Schema.from({
    app: Schema.ref(App),
    path: Schema.string(),
    content: Schema.string(),
  });

  /** A frozen copy of one draft at publish time. What …/apps/<name>/ serves. */
  const ReleaseFile = Schema.from({
    release: Schema.ref(Release),
    path: Schema.string(),
    content: Schema.string(),
  });

  return { app: App, draftFile: DraftFile, release: Release, releaseFile: ReleaseFile };
}

export type PlatformEntities<U extends EntityDef = EntityDef> = ReturnType<typeof platformEntities<U>>;

/** Find the platform's entities in a built workspace schema, by their fixed registry keys. */
export function platformEntitiesOf(schema: AppSchema): PlatformEntities {
  const { app, draftFile, release, releaseFile } = schema.entities as unknown as Partial<PlatformEntities>;
  if (!app || !draftFile || !release || !releaseFile) {
    throw new Error(
      "The workspace schema must spread platformEntities(User) into Schema.build — " +
        'keys "app", "draftFile", "release", "releaseFile".',
    );
  }
  return { app, draftFile, release, releaseFile };
}
