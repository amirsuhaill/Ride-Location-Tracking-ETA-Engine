import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // node-pg-migrate migrations are plain CommonJS by convention (not part of the TS build).
    files: ["migrations/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { exports: "writable", module: "readonly", require: "readonly" },
    },
  },
);
