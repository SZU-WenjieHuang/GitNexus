import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findNodeAtRange,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { getCppParser, getCppScopeQuery } from './query.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { splitCppInclude, splitCppUsingDecl } from './import-decomposer.js';
import { computeCppDeclarationArity, computeCppCallArity } from './arity-metadata.js';
import { markFileLocal } from './file-local-linkage.js';
import { markCppDependentBase } from './two-phase-lookup.js';

export function emitCppScopeCaptures(
  sourceText: string,
  filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getCppParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getCppParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const rawMatches = getCppScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];

  // Track ranges where typedef-struct was captured as @declaration.struct
  // so we can suppress the duplicate @declaration.typedef match.
  const structTypedefRanges = new Set<string>();

  for (const m of rawMatches) {
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;

    // ── Handle #include statements ──────────────────────────────────
    if (grouped['@import.statement'] !== undefined) {
      const anchor = grouped['@import.statement']!;
      const includeNode = findNodeAtRange(tree.rootNode, anchor.range, 'preproc_include');
      if (includeNode !== null) {
        const split = splitCppInclude(includeNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Handle using declarations (using namespace / using name) ────
    if (grouped['@import.using-decl'] !== undefined) {
      const anchor = grouped['@import.using-decl']!;
      const usingNode = findNodeAtRange(tree.rootNode, anchor.range, 'using_declaration');
      if (usingNode !== null) {
        const split = splitCppUsingDecl(usingNode);
        if (split !== null) {
          out.push(split);
          continue;
        }
      }
    }

    // ── Track typedef-struct ranges ─────────────────────────────────
    const structAnchor = grouped['@declaration.struct'] ?? grouped['@declaration.class'];
    if (structAnchor !== undefined) {
      const r = structAnchor.range;
      structTypedefRanges.add(`${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`);
    }

    // Suppress @declaration.typedef if the same range was already captured
    const typedefAnchor = grouped['@declaration.typedef'];
    if (typedefAnchor !== undefined) {
      const r = typedefAnchor.range;
      const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
      if (structTypedefRanges.has(key)) continue;
    }

    // ── Enrich function/method declarations with arity metadata ─────
    const declAnchor = grouped['@declaration.function'] ?? grouped['@declaration.method'];
    if (declAnchor !== undefined) {
      const fnNode =
        findNodeAtRange(tree.rootNode, declAnchor.range, 'function_definition') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'declaration') ??
        findNodeAtRange(tree.rootNode, declAnchor.range, 'field_declaration');
      if (fnNode !== null) {
        const arity = computeCppDeclarationArity(fnNode);
        if (arity.parameterCount !== undefined) {
          grouped['@declaration.parameter-count'] = syntheticCapture(
            '@declaration.parameter-count',
            fnNode,
            String(arity.parameterCount),
          );
        }
        if (arity.requiredParameterCount !== undefined) {
          grouped['@declaration.required-parameter-count'] = syntheticCapture(
            '@declaration.required-parameter-count',
            fnNode,
            String(arity.requiredParameterCount),
          );
        }
        if (arity.parameterTypes !== undefined) {
          grouped['@declaration.parameter-types'] = syntheticCapture(
            '@declaration.parameter-types',
            fnNode,
            JSON.stringify(arity.parameterTypes),
          );
        }

        // Detect static storage class (file-local linkage)
        if (hasStaticStorageClass(fnNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }

        // Detect anonymous namespace (file-local linkage)
        if (isInsideAnonymousNamespace(fnNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }
      }
    }

    // ── Detect static variables (file-local linkage) ────────────────
    const varDeclAnchor = grouped['@declaration.variable'];
    if (varDeclAnchor !== undefined) {
      const varNode = findNodeAtRange(tree.rootNode, varDeclAnchor.range, 'declaration');
      if (varNode !== null) {
        if (hasStaticStorageClass(varNode) || isInsideAnonymousNamespace(varNode)) {
          const nameText = grouped['@declaration.name']?.text;
          if (nameText !== undefined) {
            markFileLocal(filePath, nameText);
          }
        }
      }
    }

    // ── Enrich call references with arity ───────────────────────────
    const callAnchor =
      grouped['@reference.call.free'] ??
      grouped['@reference.call.member'] ??
      grouped['@reference.call.qualified'];
    if (callAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = findNodeAtRange(tree.rootNode, callAnchor.range, 'call_expression');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(computeCppCallArity(callNode)),
        );
      }
    }

    // ── Enrich constructor calls (new Foo()) with arity ─────────────
    const ctorCallAnchor = grouped['@reference.call.constructor'];
    if (ctorCallAnchor !== undefined && grouped['@reference.arity'] === undefined) {
      const newNode = findNodeAtRange(tree.rootNode, ctorCallAnchor.range, 'new_expression');
      if (newNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          newNode,
          String(computeCppCallArity(newNode)),
        );
      }
    }

    // ── Synthesize argument types for overload narrowing ────────────
    const anyCallAnchor = callAnchor ?? ctorCallAnchor;
    if (anyCallAnchor !== undefined && grouped['@reference.parameter-types'] === undefined) {
      const cNode =
        findNodeAtRange(tree.rootNode, anyCallAnchor.range, 'call_expression') ??
        findNodeAtRange(tree.rootNode, anyCallAnchor.range, 'new_expression');
      if (cNode !== null) {
        const argTypes = inferCppCallArgTypes(cNode);
        if (argTypes !== undefined && argTypes.length > 0) {
          grouped['@reference.parameter-types'] = syntheticCapture(
            '@reference.parameter-types',
            cNode,
            JSON.stringify(argTypes),
          );
        }
      }
    }

    // ── Post-process @type-binding.assignment for auto declarations ──
    // The wildcard `type: (_)` in the @type-binding.assignment query
    // pattern matches before the more specific @type-binding.alias and
    // @type-binding.member-access patterns. When the type is `auto`
    // (placeholder_type_specifier), we re-inspect the AST to synthesize
    // the correct capture tags so interpret.ts can produce the right
    // rawTypeName for compound-receiver chain resolution.
    if (
      grouped['@type-binding.assignment'] !== undefined &&
      grouped['@type-binding.type']?.text === 'auto'
    ) {
      const anchor = grouped['@type-binding.assignment']!;
      const declNode = findNodeAtRange(tree.rootNode, anchor.range, 'declaration');
      if (declNode !== null) {
        const declarator = declNode.childForFieldName('declarator');
        if (declarator?.type === 'init_declarator') {
          const valueNode = declarator.childForFieldName('value');
          if (valueNode !== null) {
            if (valueNode.type === 'identifier') {
              // auto alias = existingVar → promote to @type-binding.alias
              grouped['@type-binding.alias'] = anchor;
              grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', valueNode);
              delete grouped['@type-binding.assignment'];
            } else if (valueNode.type === 'field_expression') {
              // auto addr = user.address → promote to @type-binding.member-access
              const argNode = valueNode.childForFieldName('argument');
              const fieldNode = valueNode.childForFieldName('field');
              if (argNode !== null && fieldNode !== null) {
                grouped['@type-binding.member-access'] = anchor;
                grouped['@type-binding.member-access-receiver'] = nodeToCapture(
                  '@type-binding.member-access-receiver',
                  argNode,
                );
                grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', fieldNode);
                delete grouped['@type-binding.assignment'];
              }
            } else if (valueNode.type === 'call_expression') {
              const fnNode = valueNode.childForFieldName('function');
              if (fnNode?.type === 'field_expression') {
                // auto city = addr.getCity() → promote to @type-binding.alias
                // with dotted rawName "addr.getCity" for compound-receiver
                const argNode = fnNode.childForFieldName('argument');
                const fieldNode = fnNode.childForFieldName('field');
                if (argNode !== null && fieldNode !== null) {
                  grouped['@type-binding.member-access'] = anchor;
                  grouped['@type-binding.member-access-receiver'] = nodeToCapture(
                    '@type-binding.member-access-receiver',
                    argNode,
                  );
                  grouped['@type-binding.type'] = nodeToCapture('@type-binding.type', fieldNode);
                  delete grouped['@type-binding.assignment'];
                }
              }
            }
          }
        }
      }
    }

    out.push(grouped);
  }

  // ── Detect dependent-base relationships for two-phase template lookup ──
  // Walk the tree once, finding every `template_declaration` whose
  // child is a class/struct definition with a `base_class_clause` whose
  // base names reference an in-scope template parameter. Record the
  // (className, dependentBaseName) pair so `populateCppDependentBases`
  // (called from the `populateOwners` hook) can resolve names to nodeIds
  // and the resolver can suppress unqualified-call binding to those
  // bases per ISO C++ two-phase lookup.
  detectCppDependentBases(tree.rootNode, filePath);

  return out;
}

/**
 * Walk the AST finding every template_declaration containing a class or
 * struct definition with a dependent base. Records (className, baseName)
 * pairs into the module-level state via `markCppDependentBase`.
 *
 * A base is "dependent" when its name (typically a template_type like
 * `Base<T>`) uses a template parameter of the enclosing template_declaration.
 * Conservative bias: `typename T::U`, `decltype(...)` and template-template
 * parameter shapes are also treated as dependent.
 */
function detectCppDependentBases(root: SyntaxNode, filePath: string): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'template_declaration') {
      // Collect template-parameter names declared by this declaration.
      // Inner template_declarations shadow outer ones — handled by the
      // recursive descent below (each template_declaration creates its
      // own parameter scope).
      const params = collectTemplateParameterNames(node);

      // Find the class/struct definition inside this template_declaration.
      const classNode = findChildOfType(node, [
        'class_specifier',
        'struct_specifier',
      ]);
      if (classNode !== null) {
        const className = getTypeIdentifierName(classNode);
        if (className !== '') {
          const baseClause = findChildOfType(classNode, ['base_class_clause']);
          if (baseClause !== null) {
            for (const base of iterBaseClasses(baseClause)) {
              if (isBaseDependent(base, params)) {
                const baseName = extractBaseSimpleName(base);
                if (baseName !== '') {
                  markCppDependentBase(filePath, className, baseName);
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }
}

/** Collect simple template parameter names from a template_declaration. */
function collectTemplateParameterNames(templateDecl: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const paramList = findChildOfType(templateDecl, ['template_parameter_list']);
  if (paramList === null) return names;
  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (param === null) continue;
    if (
      param.type === 'type_parameter_declaration' ||
      param.type === 'optional_type_parameter_declaration' ||
      param.type === 'variadic_type_parameter_declaration'
    ) {
      const idNode = findFirstDescendantOfType(param, 'type_identifier');
      if (idNode !== null) names.add(idNode.text);
    } else if (
      param.type === 'parameter_declaration' ||
      param.type === 'optional_parameter_declaration' ||
      param.type === 'variadic_parameter_declaration'
    ) {
      // Non-type template parameter (e.g. `template<int N>`).
      const idNode = findFirstDescendantOfType(param, 'identifier');
      if (idNode !== null) names.add(idNode.text);
    } else if (param.type === 'template_template_parameter_declaration') {
      // template-template parameter (e.g. `template<template<class> class TT>`)
      const idNode = findFirstDescendantOfType(param, 'type_identifier');
      if (idNode !== null) names.add(idNode.text);
    }
  }
  return names;
}

/** Yield each base-class entry from a `base_class_clause`. */
function* iterBaseClasses(baseClause: SyntaxNode): IterableIterator<SyntaxNode> {
  for (let i = 0; i < baseClause.childCount; i++) {
    const child = baseClause.child(i);
    if (child === null) continue;
    // Skip ':', ',', and access_specifier nodes — the base names are
    // type_identifier, template_type, or qualified_identifier.
    if (
      child.type === 'type_identifier' ||
      child.type === 'template_type' ||
      child.type === 'qualified_identifier'
    ) {
      yield child;
    }
  }
}

/**
 * A base is dependent when:
 *   - it's a `template_type` and its argument list contains a
 *     `type_identifier` matching one of the enclosing template's params
 *     (e.g., `Base<T>` where `T` is a template parameter), OR
 *   - it contains a `typename`, `decltype`, or `template_template_parameter`
 *     shape (conservatively treated as dependent).
 *
 * Non-dependent: `Base<int>`, `ConcreteBase`, `Base<MyConcrete>` where
 * `MyConcrete` is not a template parameter.
 */
function isBaseDependent(baseNode: SyntaxNode, templateParams: Set<string>): boolean {
  if (baseNode.type !== 'template_type') {
    // Bare `type_identifier` or `qualified_identifier` bases — not
    // dependent (the base name itself doesn't reference a template
    // parameter at this level).
    return false;
  }
  // Walk all descendants of the template_argument_list looking for any
  // type_identifier matching a template parameter, or any conservative-
  // dependent shape.
  const stack: SyntaxNode[] = [baseNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'type_identifier' && templateParams.has(node.text)) {
      return true;
    }
    if (
      node.type === 'decltype' ||
      node.type === 'dependent_type' ||
      node.type === 'template_template_parameter_declaration'
    ) {
      return true;
    }
    if (node.type === 'qualified_identifier') {
      // `typename T::U` or `T::nested` — if any inner identifier matches
      // a template parameter, dependent.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c !== null) stack.push(c);
      }
      continue;
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c !== null) stack.push(c);
    }
  }
  return false;
}

/** Extract the simple name of a base class node. */
function extractBaseSimpleName(baseNode: SyntaxNode): string {
  if (baseNode.type === 'type_identifier') return baseNode.text;
  if (baseNode.type === 'template_type') {
    const nameNode = baseNode.childForFieldName('name');
    if (nameNode !== null) return nameNode.text;
    // Fallback: first type_identifier descendant.
    const id = findFirstDescendantOfType(baseNode, 'type_identifier');
    if (id !== null) return id.text;
  }
  if (baseNode.type === 'qualified_identifier') {
    const nameNode = baseNode.childForFieldName('name');
    if (nameNode !== null) return nameNode.text;
  }
  return '';
}

/** Find the first direct child matching one of the given types. */
function findChildOfType(node: SyntaxNode, types: readonly string[]): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c !== null && types.includes(c.type)) return c;
  }
  return null;
}

/** Recursive search for the first descendant of a given type. */
function findFirstDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c === null) continue;
    const hit = findFirstDescendantOfType(c, type);
    if (hit !== null) return hit;
  }
  return null;
}

/** Get the name of a class/struct/template_type node via its `name` field. */
function getTypeIdentifierName(node: SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode !== null) return nameNode.text;
  const id = findFirstDescendantOfType(node, 'type_identifier');
  return id !== null ? id.text : '';
}

/**
 * Infer argument types from a call_expression or new_expression node.
 * Used for overload disambiguation by parameter types.
 *
 * Only literal types are inferred — identifiers and complex expressions
 * return empty string (unknown) so narrowOverloadCandidates treats them
 * as any-match.
 */
function inferCppCallArgTypes(node: SyntaxNode): string[] | undefined {
  const argList = node.childForFieldName('arguments');
  if (argList === null) return undefined;

  const types: string[] = [];
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.type === '(' || child.type === ')') continue;
    const litType = inferCppLiteralType(child);
    if (litType !== '') {
      types.push(litType);
    } else if (child.type === 'identifier') {
      // Variable reference — look up declared type in enclosing scope
      types.push(lookupDeclaredTypeForIdentifier(child));
    } else {
      types.push('');
    }
  }
  return types.length > 0 ? types : undefined;
}

/**
 * Infer the canonical type name of a C++ literal AST node.
 * Returns empty string for non-literal / unknown nodes.
 */
function inferCppLiteralType(node: SyntaxNode): string {
  switch (node.type) {
    case 'number_literal': {
      const text = node.text;
      // Floating-point literals contain '.', 'e', 'E', or end with 'f'/'F'
      if (
        text.includes('.') ||
        text.includes('e') ||
        text.includes('E') ||
        text.endsWith('f') ||
        text.endsWith('F')
      ) {
        return 'double';
      }
      return 'int';
    }
    case 'string_literal':
    case 'raw_string_literal':
    case 'concatenated_string':
      return 'string';
    case 'char_literal':
      return 'char';
    case 'true':
    case 'false':
      return 'bool';
    case 'null':
    case 'nullptr':
      return 'null';
    default:
      return '';
  }
}

/**
 * Look up the declared type of a variable by scanning sibling declarations
 * in the enclosing compound_statement (function body). Handles:
 *   - `std::string result = ...` → 'string'
 *   - `int n = ...` → 'int'
 *   - `const int n = ...` → 'int'
 * Returns empty string if no declaration found or type is auto/placeholder.
 */
function lookupDeclaredTypeForIdentifier(identNode: SyntaxNode): string {
  const varName = identNode.text;
  // Walk up to the enclosing compound_statement (function body)
  let scope: SyntaxNode | null = identNode.parent;
  while (
    scope !== null &&
    scope.type !== 'compound_statement' &&
    scope.type !== 'translation_unit'
  ) {
    scope = scope.parent;
  }
  if (scope === null) return '';

  // Scan declarations in the scope for a matching variable name
  for (let i = 0; i < scope.childCount; i++) {
    const stmt = scope.child(i);
    if (stmt === null || stmt.type !== 'declaration') continue;

    const typeNode = stmt.childForFieldName('type');
    if (typeNode === null) continue;
    // Skip auto/placeholder types — those need chain-follow, not literal
    if (typeNode.type === 'placeholder_type_specifier') continue;

    // Check init_declarator children for the variable name
    const declarator = stmt.childForFieldName('declarator');
    if (declarator === null) continue;
    if (declarator.type === 'init_declarator') {
      const nameChild = declarator.childForFieldName('declarator');
      if (nameChild !== null && nameChild.text === varName) {
        return normalizeCppTypeText(typeNode.text);
      }
    } else if (declarator.text === varName) {
      return normalizeCppTypeText(typeNode.text);
    }
  }
  return '';
}

/** Normalize a type-specifier text for argument type matching.
 *  Strips qualifiers (const, volatile), namespace prefixes (std::),
 *  and pointer/reference markers. */
function normalizeCppTypeText(text: string): string {
  let t = text.trim();
  t = t.replace(/\b(const|volatile|static|extern|mutable)\b/g, '').trim();
  t = t.replace(/^.*::/, ''); // strip namespace prefix
  t = t.replace(/[*&]/g, '').trim();
  return t;
}

/**
 * Check if a C++ function_definition or declaration has `static` storage class.
 */
function hasStaticStorageClass(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null && child.type === 'storage_class_specifier' && child.text === 'static') {
      return true;
    }
  }
  return false;
}

/**
 * Check if a node is inside an anonymous namespace (file-local linkage in C++).
 * Anonymous namespaces have no `name` field in tree-sitter-cpp.
 */
function isInsideAnonymousNamespace(node: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = node.parent ?? null;
  while (ancestor !== null) {
    if (ancestor.type === 'namespace_definition') {
      // Anonymous namespace: has declaration_list but no name child
      const nameChild = ancestor.childForFieldName?.('name') ?? null;
      if (nameChild === null) return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}
