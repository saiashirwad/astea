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
  rules: {
    "import/no-cycle": "error",
    "import/no-self-import": "error",
    "no-restricted-imports": ["error", { paths: [
      { name: "safemods", message: "Import the concrete source module inside the package." },
    ] }],
  },
  overrides: [
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
    {
      files: ["src/**/*.test.ts", "examples/**/*.ts"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
})
