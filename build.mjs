// Bundles the action + its dependencies (AI SDK, zod) into a single file so the
// composite action can run with no `npm install` step at runtime. Run on every
// release: `node build.mjs` → dist/index.mjs (committed).

import { build } from "esbuild";

await build({
  entryPoints: ["src/index.mjs"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.mjs",
  // Keep Node built-ins external; bundle everything else (the AI SDK tree).
  // esbuild treats node: imports as external on platform:node automatically.
  banner: {
    // esbuild's ESM output doesn't provide require(); some transitive deps call
    // it for Node built-ins. Shim it via createRequire so the bundle is runnable.
    js: [
      "// Bundled by build.mjs — do not edit. Edit src/ and re-run `npm run build`.",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "info",
});

console.log("Built dist/index.mjs");
