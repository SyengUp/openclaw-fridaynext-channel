import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "scripts/**",
      "install.js",
      "install-ui.js",
      "eslint.config.js",
      "vitest.config.ts",
      "vitest.e2e.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_`-prefixed names are an intentional "deliberately unused" convention
      // (call-site-compat params, destructure throwaways).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // HTTP handlers are uniformly typed `(req,res) => Promise<boolean>` and
      // SDK callbacks (sendText/buildAccountSnapshot/onReasoning*) present an async
      // signature by contract — several have nothing to await yet. Stripping `async`
      // would break the uniform handler type and cascade into await-thenable errors
      // at the call sites, so this rule fights a deliberate convention here.
      "@typescript-eslint/require-await": "off",
      // The OpenClaw host SDK / runtime is an untyped `any` boundary
      // (openclaw.d.ts is a hand-written shim, core types live out of repo).
      // These fire structurally on every SDK access — surface as warnings,
      // not blocking errors. The real signal is the error-level rules below.
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Pure declaration shim for the untyped host — `any` everywhere is by design.
    files: ["src/openclaw.d.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  {
    // Tests, test-support and e2e are excluded from the build tsconfig, so
    // type-aware linting can't see them — fall back to syntactic rules only.
    // Mocks also legitimately use `any`, so relax the unsafe-* family.
    files: ["src/**/*.test.ts", "src/test-support/**", "src/e2e/**"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  prettier,
);
