/**
 * The implicit index.html every app gets unless it writes its own: Tailwind,
 * an import map wiring the SDK (ONE bundle — one module instance, so
 * `instanceof` and identity hold), the workspace schema module, and Preact
 * with `htm` — components in plain JavaScript, no build step anywhere.
 * `react` maps to preact/compat, so triple-sdk/react's hooks work unchanged.
 */
export function shell(app: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${app}</title>
<script type="importmap">
{
  "imports": {
    "triple-sdk/client": "/platform/sdk.js",
    "triple-sdk/query": "/platform/sdk.js",
    "triple-sdk/react": "/platform/sdk.js",
    "triple-sdk/schema": "/platform/sdk.js",
    "schema": "/platform/schema.js",
    "react": "https://esm.sh/preact@10.24.3/compat",
    "react/jsx-runtime": "https://esm.sh/preact@10.24.3/compat/jsx-runtime",
    "react-dom/client": "https://esm.sh/preact@10.24.3/compat/client",
    "preact": "https://esm.sh/preact@10.24.3",
    "preact/hooks": "https://esm.sh/preact@10.24.3/hooks",
    "htm/preact": "https://esm.sh/htm@3.1.1/preact?deps=preact@10.24.3"
  }
}
</script>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div id="root"></div>
<script type="module" src="./app.js"></script>
</body>
</html>`;
}
