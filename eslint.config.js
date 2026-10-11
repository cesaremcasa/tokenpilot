import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "release-artifacts/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Defensive initial values before try/catch and fail-open launcher state are intentional here.
      "no-useless-assignment": "off"
    }
  },
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly" }
    }
  }
);
