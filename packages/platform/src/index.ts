/**
 * workspace-platform — apps as data over a workspace cell, and the workspace's
 * own schema as data (§4.9).
 *
 *   ./schema   the platform's entities (shared shape; spread into Schema.build)
 *   ./policy   the platform's rules (server only)
 *   .          the runtime: createPlatform, the MCP endpoint, app serving,
 *              and the workspace builder: declarations in, schema + policy out
 */
export { createPlatform, contentType, type Platform, type Served } from "./platform.ts";
export { handleMcp, TOOLS, type McpOptions } from "./mcp.ts";
export { serveApp } from "./serve.ts";
export { shell } from "./shell.ts";
export {
  buildWorkspace,
  migrationProblems,
  schemaModule,
  userPolicy,
  validateDeclaration,
  EMPTY_DECLARATION,
  type Workspace,
  type WorkspaceDeclaration,
  type WorkspaceEntityDeclaration,
} from "./workspace.ts";
export { compileRules, evaluate, RULE_LANGUAGE, type EntityRules, type Rule } from "./rules.ts";
