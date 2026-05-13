import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { findClassBindingInScope, findEnclosingClassDef } from '../../scope-resolution/scope/walkers.js';
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

  // Simple `isSuperReceiver` returns false for C++. Real super
  // classification is caller-context-dependent and lives in
  // `isSuperReceiverInContext` below — without scope context the
  // previous regex `/^[A-Z]\w*::/` misclassified namespace-qualified
  // calls (e.g., `Singleton::getInstance()`) as super calls and routed
  // them through the wrong resolution branch.
  isSuperReceiver: () => false,

  isSuperReceiverInContext: (text, callerScope, scopes) => {
    // Extract LHS of `::`. C++ super calls take the form `Base::method()`
    // where `Base` is a direct or indirect base of the caller's
    // enclosing class. Anything not in `Class::` form is not a super
    // call.
    const sepIdx = text.indexOf('::');
    if (sepIdx <= 0) return false;
    const lhs = text.slice(0, sepIdx).trim();
    if (lhs.length === 0) return false;

    // Resolve the LHS in the caller's scope chain. Only class-like
    // resolutions can be super receivers; Namespace and unresolved
    // names are not super calls.
    const lhsDef = findClassBindingInScope(callerScope, lhs, scopes);
    if (lhsDef === undefined) return false;

    // The caller must have an enclosing class — super calls only make
    // sense inside a class body. Free functions can use `ClassName::`
    // for namespace-qualified calls but those are not super.
    const enclosing = findEnclosingClassDef(callerScope, scopes);
    if (enclosing === undefined) return false;

    // `lhsDef` must be in the caller's MRO (i.e., the caller's enclosing
    // class derives from it). The class itself counts as its own MRO
    // root — `Self::method()` is a qualified self-call, not a super
    // call, so exclude the caller's own class.
    if (lhsDef.nodeId === enclosing.nodeId) return false;
    const mro = scopes.methodDispatch.mroFor(enclosing.nodeId);
    return mro.includes(lhsDef.nodeId);
  },

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
