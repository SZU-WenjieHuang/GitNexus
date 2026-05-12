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
import { expandCppWildcardNames, isFileLocal, clearFileLocalNames } from './file-local-linkage.js';
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

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

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
  // C++ `static` functions and anonymous namespace symbols have file-local
  // linkage — exclude them from global free-call fallback cross-file resolution.
  isFileLocalDef: (def: SymbolDefinition) => {
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    return isFileLocal(def.filePath, simple);
  },
};
