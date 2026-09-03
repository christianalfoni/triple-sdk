/**
 * workspace-platform — apps as data over a workspace cell.
 *
 *   ./schema   the platform's entities (shared shape; spread into Schema.build)
 *   ./policy   the platform's rules (server only)
 *   .          the runtime: createPlatform, the MCP endpoint, app serving
 */
export { createPlatform, contentType, type Platform, type Served } from "./platform.ts";
export { handleMcp, TOOLS, type McpOptions } from "./mcp.ts";
export { serveApp } from "./serve.ts";
export { shell } from "./shell.ts";
