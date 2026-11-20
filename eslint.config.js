import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "internal/scripts/**",
      ".cache/**",
      ".tui-test/**",
      "workspace/**",
      ".tmp*/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    }
  },
  {
    files: ["src/shared/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "../app/*",
            "../domain/*",
            "../infra/*",
            "../lib/*",
            "../presentation/*",
            "../../app/*",
            "../../domain/*",
            "../../infra/*",
            "../../lib/*",
            "../../presentation/*",
            "../../../app/*",
            "../../../domain/*",
            "../../../infra/*",
            "../../../lib/*",
            "../../../presentation/*"
          ]
        }
      ]
    }
  },
  {
    files: ["src/domain/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "../app/*",
            "../infra/*",
            "../lib/*",
            "../presentation/*",
            "../../app/*",
            "../../infra/*",
            "../../lib/*",
            "../../presentation/*",
            "../../../app/*",
            "../../../infra/*",
            "../../../lib/*",
            "../../../presentation/*",
            "../../../../app/*",
            "../../../../infra/*",
            "../../../../lib/*",
            "../../../../presentation/*"
          ]
        }
      ]
    }
  },
  {
    files: ["src/app/**/*.js", "src/infra/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "../presentation/*",
            "../../presentation/*",
            "../../../presentation/*",
            "../../../../presentation/*",
            "../../../../../presentation/*"
          ]
        }
      ]
    }
  }
];
