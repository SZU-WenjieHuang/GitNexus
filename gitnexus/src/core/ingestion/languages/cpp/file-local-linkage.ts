import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';

/**
 * Per-file set of symbol names with file-local linkage.
 * In C++ there are two sources of file-local linkage:
 *   1. `static` storage class (same as C)
 *   2. Anonymous namespace (`namespace { ... }`)
 *
 * Populated during `emitCppScopeCaptures` and consumed by
 * `expandCppWildcardNames` to exclude file-local symbols from
 * cross-file wildcard import visibility.
 *
 * NOTE: module-level state, single-process-single-repo use only.
 * Call `clearFileLocalNames()` at the start of each resolution pass.
 *
 * Key: filePath, Value: Set of file-local symbol names.
 */
const fileLocalNames = new Map<string, Set<string>>();

/** Record a symbol name as file-local (static or anonymous namespace). */
export function markFileLocal(filePath: string, name: string): void {
  let names = fileLocalNames.get(filePath);
  if (names === undefined) {
    names = new Set<string>();
    fileLocalNames.set(filePath, names);
  }
  names.add(name);
}

/** Check whether a symbol name has file-local linkage in the given file. */
export function isFileLocal(filePath: string, name: string): boolean {
  return fileLocalNames.get(filePath)?.has(name) ?? false;
}

/** Clear tracked file-local names (call at start of each resolution pass). */
export function clearFileLocalNames(): void {
  fileLocalNames.clear();
}

/**
 * Return the names visible through a C++ wildcard import (`#include`).
 * All module-scope defs from the target file are visible EXCEPT those
 * with file-local linkage (static functions/variables, anonymous namespace symbols).
 */
export function expandCppWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const name = simpleName(def);
    if (name === '') continue;
    if (isFileLocal(target.filePath, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}
