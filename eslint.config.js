// Flat ESLint config — intentionally minimal. This project was previously
// unlinted, so we enable ONLY the UI-unification guardrails (plus rules-of-hooks)
// rather than a broad ruleset that would flood on pre-existing patterns.
//
// Guardrails enforced (see CLAUDE.md "UI conventions"):
//  1. No raw `overflow-*: auto|scroll` classes in views — use <PanelBody>/<ScrollArea>,
//     otherwise the rc-dock scroll contract breaks (whole panel scrolls).
//  2. No raw <button> in views — use <Button>/<ContextMenuItem>.
//  3. No raw <input>/<select>/<textarea> in views — use <Input>/<Checkbox>/<Select>.
//  4. No raw chromatic Tailwind hues (text-blue-400, bg-red-500, …) in views — use
//     the semantic tokens (--syn-* / destructive / muted; see App.css). Neutral
//     scales (gray/neutral/zinc) are allowed. A deliberate categorical scale can
//     opt out with an eslint-disable block and a comment saying why.
// `src/components/ui/**` is exempt (the primitives legitimately use these).

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

const rawHuePattern =
  "\\b(?:text|bg|border|fill|stroke|ring|divide|outline)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d";
const noRawHueMessage =
  "Don't use raw Tailwind hue classes in a view — use the semantic color tokens (syn-*, destructive, muted; see the --syn-* palette in App.css) so every color keeps one meaning.";

const noRawHueLiteral = {
  selector: `Literal[value=/${rawHuePattern}/]`,
  message: noRawHueMessage,
};

const noRawHueTemplate = {
  selector: `TemplateElement[value.raw=/${rawHuePattern}/]`,
  message: noRawHueMessage,
};

const noRawFormControl = {
  selector: "JSXOpeningElement[name.name=/^(input|select|textarea)$/]",
  message:
    "Don't use a raw <input>/<select>/<textarea> in a view — use <Input>, <Checkbox>, or <Select> from @/components/ui (for a multi-line field, add a Textarea primitive there first).",
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
        noRawFormControl,
        noRawHueLiteral,
        noRawHueTemplate,
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
