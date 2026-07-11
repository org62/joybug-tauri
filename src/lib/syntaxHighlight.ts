// Whole-file syntax tokenization for the Source view.
//
// The source view renders one line per virtualized row, so we tokenize the
// entire file once (on load) and split tokens on newlines into per-line token
// arrays. Tokenizing the whole file — rather than each line independently —
// keeps multi-line constructs (block comments, raw strings) correctly colored.
import Prism from "prismjs";
// Language grammars must be imported in dependency order (clike → c → cpp).
import "prismjs/components/prism-clike";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-nasm";

// We only use Prism.tokenize; suppress its automatic DOM highlighting.
Prism.manual = true;

/** A single styled span within a source line. */
export interface SyntaxToken {
  text: string;
  /** Prism token type/alias (e.g. "comment", "keyword") or null for plain text. */
  type: string | null;
}

export type SyntaxLine = SyntaxToken[];

/** Files larger than this are shown unhighlighted to avoid tokenization jank. */
const MAX_HIGHLIGHT_LINES = 20000;

/** Map a source file path to a Prism language key, or null if unsupported. */
export function languageForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "c++":
    case "hpp":
    case "hh":
    case "hxx":
    case "inl":
      return "cpp";
    case "rs":
      return "rust";
    case "asm":
    case "s":
    case "inc":
    case "masm":
    case "nasm":
      return "nasm";
    default:
      return null;
  }
}

/** Append `text` (which may contain newlines) to `lines`, starting new lines as needed. */
function pushText(lines: SyntaxLine[], text: string, type: string | null) {
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) lines.push([]);
    if (parts[i]) lines[lines.length - 1].push({ text: parts[i], type });
  }
}

/** Flatten a Prism token tree into the current line buffer, splitting on newlines. */
function walk(lines: SyntaxLine[], token: string | Prism.Token, inheritedType: string | null) {
  if (typeof token === "string") {
    pushText(lines, token, inheritedType);
    return;
  }
  // Prefer the most specific alias for coloring, else the token type.
  const alias = Array.isArray(token.alias) ? token.alias[0] : token.alias;
  const type = (alias as string) || token.type || inheritedType;
  if (typeof token.content === "string") {
    pushText(lines, token.content, type);
  } else if (Array.isArray(token.content)) {
    for (const child of token.content) walk(lines, child, type);
  } else {
    walk(lines, token.content, type);
  }
}

/**
 * Tokenize `code` into per-line token arrays aligned with `code.split("\n")`.
 * Returns null when the language is unsupported or the file is too large — the
 * caller should then render plain text.
 */
export function highlightToLines(code: string, language: string | null): SyntaxLine[] | null {
  if (!language) return null;
  const grammar = Prism.languages[language];
  if (!grammar) return null;
  // Cheap guard before the (more expensive) tokenize.
  if (code.length > MAX_HIGHLIGHT_LINES * 400) return null;

  const lineCount = code.split("\n").length;
  if (lineCount > MAX_HIGHLIGHT_LINES) return null;

  let tokens: Array<string | Prism.Token>;
  try {
    tokens = Prism.tokenize(code, grammar);
  } catch {
    return null;
  }

  const lines: SyntaxLine[] = [[]];
  for (const token of tokens) walk(lines, token, null);
  return lines;
}
