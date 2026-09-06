import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * Import boundary for the pure reasoning engines.
 *
 * The Signal Engine and the Diagnosis Engine are pure functions over
 * already-computed inputs: metrics in, signals out; signals in, diagnoses out.
 * They must never reach the database, an LLM, or the network. Doc comments are
 * not the risk — imports are — so the boundary is enforced by lint and fails
 * the build on violation.
 *
 * The Action Engine is here for a different reason. It is the stage a reader
 * would most expect to send a WhatsApp message or write a row, because its whole
 * subject is doing things — so it is the stage where the "prepares work, never
 * performs it" rule most needs teeth. Adding a network client, a database client
 * or a model to it fails the build.
 */
const PURE_ENGINE_FILES = [
  "business-brain/engines/signals/**/*.ts",
  "business-brain/engines/diagnosis/**/*.ts",
  "business-brain/engines/action/**/*.ts",
];

const FORBIDDEN_IMPORT_PATTERNS = [
  {
    group: [
      "**/repositories",
      "**/repositories/**",
      "**/business-brain/repositories",
      "**/business-brain/repositories/**",
    ],
    message:
      "Pure reasoning engines must not import the repositories layer. Data is passed in by the caller.",
  },
  {
    group: ["@prisma/client", "@prisma/*", ".prisma/**", "@supabase/*", "@supabase/**"],
    message:
      "Pure reasoning engines must not import a database client. Data is passed in by the caller.",
  },
  {
    group: [
      "@anthropic-ai/*",
      "@anthropic-ai/**",
      "openai",
      "openai/**",
      "@google/generative-ai",
      "@google/generative-ai/**",
      "**/lib/ai",
      "**/lib/ai/**",
    ],
    message: "Pure reasoning engines must not call an LLM. Reasoning here is deterministic.",
  },
  {
    group: [
      "axios",
      "axios/**",
      "node-fetch",
      "got",
      "superagent",
      "undici",
      "ky",
      "http",
      "https",
      "node:http",
      "node:https",
      "next/server",
    ],
    message: "Pure reasoning engines must not perform network I/O.",
  },
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    files: PURE_ENGINE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: FORBIDDEN_IMPORT_PATTERNS },
      ],
    },
  },
  {
    rules: {
      // Enforce no-any in strict mode — matches TypeScript strict: true
      "@typescript-eslint/no-explicit-any": "error",
      // Honour the leading-underscore convention the codebase already uses to
      // mean "part of this signature, deliberately not read here" — a prop a
      // component must accept because its callers and siblings pass it, but
      // which this particular renderer has no use for. Without this the rule
      // reports those as mistakes, which trains people to ignore it.
      //
      // Anything NOT underscore-prefixed is still an error, so a genuinely
      // forgotten variable is still caught.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // NOTE: no-floating-promises is a type-aware rule that requires
      // parserOptions.project (typed linting). The next/core-web-vitals
      // compat preset does not configure typed linting, so this rule
      // causes a fatal ESLint error at build time. Removed to unblock builds.
      // Re-enable by adding languageOptions.parserOptions.project if typed
      // linting is explicitly configured.
    },
  },
];

export default eslintConfig;
