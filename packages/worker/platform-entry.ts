/** The ONE browser bundle of the SDK — one file, one module instance, so
 * identity (instanceof QueryBuilder, shared Schema builders) holds across
 * everything an app imports. React stays external: the import map points it
 * at preact/compat. */
export * from "triple-sdk/client";
export { Query, toPayload } from "triple-sdk/query";
export { createHooks } from "triple-sdk/react";
export { Schema } from "triple-sdk/schema";
