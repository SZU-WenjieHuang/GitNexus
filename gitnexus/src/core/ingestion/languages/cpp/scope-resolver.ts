import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cppProvider } from '../c-cpp.js';
import { cppArityCompatibility } from './arity.js';
import { cppMergeBindings } from './merge-bindings.js';
import { resolveCppImportTarget } from './import-target.js';
import { scanCppHeaderFiles } from './header-scan.js';
import {
  expandCppWildcardNames,
  isFileLocal,
  clearFileLocalNames,
  populateCppNonGloballyVisible,
  isCppDefGloballyVisible,
} from './file-local-linkage.js';
import { populateCppRangeBindings } from './range-bindings.js';

/**
 * C++ `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * C++ extends C's scope resolution with:
 *   - Namespaces (`namespace foo { ... }`)
 *   - Classes with methods and multiple inheritance
 *   - `using namespace` (wildcard import from namespace)
 *   - `using X::name` (named import from namespace)
 *   - Anonymous namespace (file-local linkage, like C `static`)
 *   - Default parameters (requiredParameterCount < parameterCount)
 *   - Overloading (arity-based disambiguation)
 *   - Templates (V1: generic-ignored, `List<User>` ≡ `List`)
 *   - Leftmost-base MRO for multiple inheritance
 */
export const cppScopeResolver: ScopeResolver = {
  language: SupportedLanguages.CPlusPlus,
  languageProvider: cppProvider,
  importEdgeReason: 'cpp-scope: include',

  loadResolutionConfig: (repoPath: string) => {
    // Clear stale file-local-linkage data from any previous invocation.
    clearFileLocalNames();
    return scanCppHeaderFiles(repoPath);
  },

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    // Augment allFilePaths with header files discovered via loadResolutionConfig.
    // C++ .h/.hpp/.hxx/.hh files may be classified differently by language
    // detection but are importable from .cpp files via #include.
    const headerPaths = resolutionConfig as ReadonlySet<string> | undefined;
    if (headerPaths !== undefined && headerPaths.size > 0) {
      const augmented = new Set(allFilePaths);
      for (const h of headerPaths) augmented.add(h);
      return resolveCppImportTarget(targetRaw, fromFile, augmented);
    }
    return resolveCppImportTarget(targetRaw, fromFile, allFilePaths);
  },

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandCppWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming, scopeId) => cppMergeBindings(existing, incoming, scopeId),

  // Adapter: cppArityCompatibility predates ScopeResolver and uses
  // (def, callsite). ScopeResolver contract is (callsite, def).
  arityCompatibility: (callsite, def) => cppArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => {
    populateClassOwnedMembers(parsed);
    // Track namespace-nested and class-nested defs so the global free-call
    // fallback and wildcard expansion can suppress them as unqualified
    // cross-file callables.
    populateCppNonGloballyVisible(parsed);
  },

  isSuperReceiver: (text) =>
    // C++ super patterns: explicit base class call `Base::method()`
    /^[A-Z]\w*::/.test(text),

  // C++ is statically typed — disable field fallback heuristic
  fieldFallbackOnMethodLookup: false,
  // C++ needs return type propagation across #include boundaries
  propagatesReturnTypesAcrossImports: true,
  // C++ #include brings in all symbols — enable global free call fallback
  allowGlobalFreeCallFallback: true,
  // Range-for element type inference: for (auto& user : users) → bind user to User
  populateRangeBindings: populateCppRangeBindings,
  // C++ method return-type bindings need to be visible from module scope
  // for cross-file propagation and compound-receiver chain resolution.
  // cppBindingScopeFor hoists @type-binding.return to Module scope.
  hoistTypeBindingsToModule: true,
  // The `isFileLocalDef` hook on the global free-call fallback names
  // file-local linkage historically, but semantically gates "logically
  // invisible cross-file" defs. C++ extends this to also reject class-
  // owned methods/fields and namespace-nested symbols — an unqualified
  // call from a free function MUST NOT resolve to `User::save` or
  // `ns::foo` (Cppreference, "Unqualified name lookup"). Without this
  // gate, the global fallback walks every callable in the workspace
  // registry and matches any class method or namespace function by
  // simple name.
  isFileLocalDef: (def: SymbolDefinition) => {
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    if (isFileLocal(def.filePath, simple)) return true;
    // Class-owned (Method/Field) — `populateClassOwnedMembers` already
    // stamps `ownerId`; cheap fast-path before consulting the scope map.
    if (def.ownerId !== undefined) return true;
    // Namespace-nested defs — require qualification cross-file. Scope-
    // walked at `populateOwners` time into a per-file nodeId set.
    if (!isCppDefGloballyVisible(def.filePath, def.nodeId)) return true;
    return false;
  },
};
