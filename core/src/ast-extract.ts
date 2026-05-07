import { createRequire } from "node:module";

/**
 * AST-based identifier extractor backed by tree-sitter.
 *
 * Tree-sitter and the per-language grammars are declared as `optionalDependencies`
 * in package.json. If they install successfully (which requires a working C
 * toolchain and the package's prebuilt binary for the platform), the AST path
 * is used and yields structurally accurate function / class / type names. If
 * any of them fail to load at runtime, the caller falls back to the regex
 * extractor. This module never throws on a missing grammar — it just reports
 * `null` for that extension.
 *
 * The set of languages covered here intentionally stays smaller than the regex
 * extractor's coverage: tree-sitter grammars carry native compilation cost, so
 * we only ship parsers for the most common languages where structural accuracy
 * actually beats the regex (it disambiguates string/comment matches, handles
 * decorators, and reaches nested declarations the regex misses).
 */

const require = createRequire(import.meta.url);

interface GrammarSpec {
  /** npm package name (looked up at runtime via require). */
  pkg: string;
  /** Optional sub-export — used by tree-sitter-typescript which has .typescript and .tsx. */
  subExport?: "typescript" | "tsx";
  /** Tree-sitter node types whose `name` field carries an identifier we want. */
  declNodeTypes: string[];
  /** Some languages put the identifier in a child of a different type. */
  identifierTypes?: string[];
}

const GRAMMARS: Record<string, GrammarSpec> = {
  ts: {
    pkg: "tree-sitter-typescript",
    subExport: "typescript",
    declNodeTypes: [
      "function_declaration",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "method_definition",
      "method_signature",
      "function_signature",
      "abstract_method_signature",
      "variable_declarator",
      "public_field_definition",
      "property_signature",
    ],
  },
  tsx: {
    pkg: "tree-sitter-typescript",
    subExport: "tsx",
    declNodeTypes: [
      "function_declaration",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "method_definition",
      "method_signature",
      "function_signature",
      "abstract_method_signature",
      "variable_declarator",
      "public_field_definition",
      "property_signature",
    ],
  },
  js: {
    pkg: "tree-sitter-javascript",
    declNodeTypes: [
      "function_declaration",
      "class_declaration",
      "method_definition",
      "variable_declarator",
    ],
  },
  py: {
    pkg: "tree-sitter-python",
    declNodeTypes: ["function_definition", "class_definition"],
  },
  go: {
    pkg: "tree-sitter-go",
    declNodeTypes: [
      "function_declaration",
      "method_declaration",
      "type_spec",
      "var_spec",
      "const_spec",
    ],
  },
  rs: {
    pkg: "tree-sitter-rust",
    declNodeTypes: [
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "type_item",
      "mod_item",
      "impl_item",
      "const_item",
      "static_item",
    ],
  },
  java: {
    pkg: "tree-sitter-java",
    declNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "method_declaration",
      "enum_declaration",
      "record_declaration",
    ],
  },
  rb: {
    pkg: "tree-sitter-ruby",
    declNodeTypes: ["method", "singleton_method", "class", "module"],
  },
  cs: {
    pkg: "tree-sitter-c-sharp",
    declNodeTypes: [
      "class_declaration",
      "interface_declaration",
      "method_declaration",
      "struct_declaration",
      "enum_declaration",
      "record_declaration",
      "delegate_declaration",
    ],
  },
};

const EXT_TO_KEY: Record<string, string> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "tsx",
  ".py": "py",
  ".pyi": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "java",
  ".rb": "rb",
  ".cs": "cs",
};

interface LoadedGrammar {
  parser: any;
  spec: GrammarSpec;
}

const cache = new Map<string, LoadedGrammar | null>();
let parserCtor: any = null;
let parserCtorTried = false;
let parserLoadError: string | null = null;

function loadParserCtor(): any | null {
  if (parserCtorTried) return parserCtor;
  parserCtorTried = true;
  try {
    parserCtor = require("tree-sitter");
    return parserCtor;
  } catch (err) {
    parserLoadError = (err as Error).message;
    return null;
  }
}

function loadGrammar(key: string): LoadedGrammar | null {
  if (cache.has(key)) return cache.get(key) ?? null;

  const Parser = loadParserCtor();
  if (!Parser) {
    cache.set(key, null);
    return null;
  }

  const spec = GRAMMARS[key];
  if (!spec) {
    cache.set(key, null);
    return null;
  }

  try {
    const mod = require(spec.pkg);
    const lang = spec.subExport ? mod[spec.subExport] : (mod.default ?? mod);
    if (!lang) {
      cache.set(key, null);
      return null;
    }
    const parser = new Parser();
    parser.setLanguage(lang);
    const loaded: LoadedGrammar = { parser, spec };
    cache.set(key, loaded);
    return loaded;
  } catch {
    cache.set(key, null);
    return null;
  }
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function nodeIdentifierName(node: any): string | null {
  // Most grammars expose a 'name' field; that field is sometimes a single
  // identifier node, sometimes a type_identifier, scoped_identifier, etc.
  const nameField =
    typeof node.childForFieldName === "function" ? node.childForFieldName("name") : null;
  if (nameField) {
    const t = nameField.text;
    if (typeof t === "string") {
      // For scoped or qualified names, take the rightmost segment.
      const last = t.split(/[.:]/).pop()?.trim() ?? t;
      if (last && IDENT_RE.test(last)) return last;
    }
  }
  // Fallback: scan immediate children for an 'identifier'-like node.
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "constant" ||
      child.type === "property_identifier"
    ) {
      const t = child.text;
      if (typeof t === "string" && IDENT_RE.test(t)) return t;
    }
  }
  return null;
}

function walk(node: any, declTypes: Set<string>, out: Set<string>): void {
  if (declTypes.has(node.type)) {
    const name = nodeIdentifierName(node);
    if (name && name.length >= 3 && name.length <= 64) out.add(name);
  }
  const count = node.namedChildCount ?? 0;
  for (let i = 0; i < count; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, declTypes, out);
  }
}

/**
 * Returns structural identifier names for the given source, or `null` if no
 * tree-sitter grammar is available for the extension. `null` signals the
 * caller to fall back to the regex extractor.
 */
export function extractWithAst(source: string, ext: string): string[] | null {
  const key = EXT_TO_KEY[ext.toLowerCase()];
  if (!key) return null;
  const g = loadGrammar(key);
  if (!g) return null;
  let tree: any;
  try {
    tree = g.parser.parse(source);
  } catch {
    return null;
  }
  if (!tree?.rootNode) return null;
  const declTypes = new Set(g.spec.declNodeTypes);
  const out = new Set<string>();
  walk(tree.rootNode, declTypes, out);
  return [...out];
}

export interface AstStatus {
  /** Whether the tree-sitter binding itself loaded. */
  parserAvailable: boolean;
  /** Reason the parser binding failed to load, if any. */
  parserError: string | null;
  /** Per-extension grammar availability. */
  grammars: { ext: string; key: string; pkg: string; available: boolean }[];
}

export function astStatus(): AstStatus {
  const parserAvailable = !!loadParserCtor();
  const grammars: AstStatus["grammars"] = [];
  for (const [key, spec] of Object.entries(GRAMMARS)) {
    const ext = Object.keys(EXT_TO_KEY).find((e) => EXT_TO_KEY[e] === key) ?? key;
    const available = parserAvailable ? !!loadGrammar(key) : false;
    grammars.push({ ext, key, pkg: spec.pkg, available });
  }
  return { parserAvailable, parserError: parserLoadError, grammars };
}

/** True if at least one grammar loaded successfully. */
export function astAnyAvailable(): boolean {
  if (!loadParserCtor()) return false;
  for (const key of Object.keys(GRAMMARS)) {
    if (loadGrammar(key)) return true;
  }
  return false;
}
