// Flat ESLint config — intentionally minimal. This project was previously
// unlinted, so we enable ONLY the UI-unification guardrails (plus rules-of-hooks)
// rather than a broad ruleset that would flood on pre-existing patterns.
//
// Guardrails enforced (see CLAUDE.md "UI conventions"):
//  1. No raw `overflow-*: auto|scroll` classes in views — use <PanelBody>/<ScrollArea>,
//     otherwise the rc-dock scroll contract breaks (whole panel scrolls).
//  2. No raw <button> in views — use <Button>/<ContextMenuItem>.
// `src/components/ui/**` is exempt (the primitives legitimately use both).

import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const noOverflowLiteral = {
  selector:
    "Literal[value=/\\boverflow-(x-|y-)?(auto|scroll)\\b/]",
  message:
    "Don't use raw overflow-*:auto/scroll classes in a view — use <PanelBody> or <ScrollArea>. Raw overflow breaks the rc-dock scroll contract.",
};

const noOverflowTemplate = {
  selector:
    "TemplateElement[value.raw=/\\boverflow-(x-|y-)?(auto|scroll)\\b/]",
  message:
    "Don't use raw overflow-*:auto/scroll classes in a view — use <PanelBody> or <ScrollArea>. Raw overflow breaks the rc-dock scroll contract.",
};

const noRawButton = {
  selector: "JSXOpeningElement[name.name='button']",
  message:
    "Don't use a raw <button> in a view — use <Button> (from @/components/ui/button) or <ContextMenuItem> (from @/components/ui/context-menu).",
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "external/**",
      "e2e/**",
      "*.config.{js,ts}",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "no-restricted-syntax": [
        "error",
        noOverflowLiteral,
        noOverflowTemplate,
        noRawButton,
      ],
    },
  },
  {
    // UI primitives legitimately use raw <button> and overflow classes
    // (portal menus, the ScrollArea itself, etc.).
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": "off",
    },
  }
);
