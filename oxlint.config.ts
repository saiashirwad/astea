import { defineConfig } from "oxlint"

export default defineConfig({
  plugins: ["import"],
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    "node_modules/**",
    "dist/**",
    "fixtures/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "import/no-cycle": "error",
    "import/no-self-import": "error",
    "no-restricted-imports": ["error", { paths: [
      { name: "safemods", message: "Import the concrete source module inside the package." },
      { name: "../api/index.ts", message: "Import the concrete source module inside the package." },
    ] }],
    "anti-slop/no-chained-type-assertions": "warn",
    "anti-slop/no-conditional-empty-object-spread": "warn",
    "anti-slop/no-known-value-widening": "warn",
    "anti-slop/no-module-mocking": "warn",
    "anti-slop/no-object-parameters": "warn",
    "anti-slop/no-reflect-apply": "warn",
    "anti-slop/no-reflect-get": "warn",
    "anti-slop/no-runtime-typeof": ["warn", { "allowInTypeGuards": true }],
    "anti-slop/no-shape-in-symbol-names": "warn",
    "anti-slop/no-unknown-parameters": "warn",
    "anti-slop/no-unknown-returns": "warn",
    "anti-slop/no-unknown-type-aliases": "warn",
    "anti-slop/no-unsafe-dictionary-type": "warn",
    "anti-slop/no-widen-then-assert": "warn",
    "anti-slop/require-safety-comment-for-type-assertion": "warn",
  },
  overrides: [
    {
      files: ["src/**/*.test.ts", "examples/**/*.ts"],
      rules: { "no-restricted-imports": "off" },
    },
    {
      files: ["src/Pattern/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["../Query/*", "../Query/**"] }],
      },
    },
    {
      files: ["src/Workspace/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["../Draft/*", "../Plan/*", "../Overlay/*", "../Preview/*", "../Verification/*", "../Application/*"] }],
      },
    },
  ],
})
