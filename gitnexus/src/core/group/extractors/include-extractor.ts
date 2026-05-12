import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { buildSuffixIndex, suffixResolve, type SuffixIndex } from '../../ingestion/import-resolvers/utils.js';

/**
 * Cross-repo C/C++ `#include` dependency extractor.
 *
 * **Provider side:** registers every `.h/.hpp/.hxx/.hh` file in the repo
 * as a provider contract with `include::<relative-path>`.
 *
 * **Consumer side:** parses all C/C++ source/header files for `#include "…"`
 * directives, attempts suffix-based resolution against the repo's own file
 * list (reusing the same algorithm as the single-repo ingestion pipeline),
 * and emits unresolved include paths as consumer contracts.
 *
 * Matching: a consumer's `include::map/base/dice_map_view.h` in repo A
 * matches a provider's `include::map/base/dice_map_view.h` in repo B via
 * exact contract-id equality in `runExactMatch`.
 */

// ---------- constants ----------

const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hxx', '.hh']);

const HEADER_GLOB = '**/*.{h,hpp,hxx,hh}';
const SOURCE_GLOB = '**/*.{c,cpp,cc,cxx,h,hpp,hxx,hh}';

const STANDARD_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/.gitnexus/**',
  '**/third_party/**',
  '**/3rdparty/**',
  '**/external/**',
];

const INCLUDE_QUERY_SRC = '(preproc_include path: (_) @import.source) @import';

/**
 * Well-known C/C++ standard library headers that can appear in `#include "…"`
 * form (some projects use quotes for system headers).
 */
const SYSTEM_HEADERS = new Set([
  // C standard
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h',
  'inttypes.h', 'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h',
  'signal.h', 'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbool.h',
  'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h',
  'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h',
  'wctype.h',
  // C++ standard (extensionless)
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset',
  'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'charconv', 'chrono',
  'cinttypes', 'climits', 'clocale', 'cmath', 'codecvt', 'compare',
  'complex', 'concepts', 'condition_variable', 'coroutine', 'csetjmp',
  'csignal', 'cstdarg', 'cstddef', 'cstdint', 'cstdio', 'cstdlib',
  'cstring', 'ctime', 'cuchar', 'cwchar', 'cwctype', 'deque', 'exception',
  'execution', 'expected', 'filesystem', 'format', 'forward_list',
  'fstream', 'functional', 'future', 'generator', 'initializer_list',
  'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch',
  'limits', 'list', 'locale', 'map', 'mdspan', 'memory', 'memory_resource',
  'mutex', 'new', 'numbers', 'numeric', 'optional', 'ostream', 'print',
  'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator',
  'semaphore', 'set', 'shared_mutex', 'source_location', 'span',
  'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept', 'stdfloat',
  'stop_token', 'streambuf', 'string', 'string_view', 'strstream',
  'syncstream', 'system_error', 'thread', 'tuple', 'type_traits',
  'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility',
  'valarray', 'variant', 'vector', 'version',
]);

/** Path prefixes that indicate system/kernel headers. */
const SYSTEM_PATH_PREFIXES = [
  'sys/', 'net/', 'netinet/', 'arpa/', 'linux/', 'asm/', 'bits/', 'gnu/',
  'mach/', 'machine/', 'xlocale/',
];

/** Regex fallback for files that exceed tree-sitter's 32 KB parse limit. */
const INCLUDE_REGEX = /^[ \t]*#\s*include\s*"([^"]+)"/gm;

// ---------- helpers ----------

function normalizeIncludePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function isAngleBracketInclude(rawNodeText: string): boolean {
  const trimmed = rawNodeText.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

function isSystemHeader(cleanedPath: string): boolean {
  // Check well-known standard headers
  if (SYSTEM_HEADERS.has(cleanedPath)) return true;
  // Check system path prefixes
  const lower = cleanedPath.toLowerCase();
  return SYSTEM_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isHeaderFile(filePath: string): boolean {
  return HEADER_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getLanguageForFile(filePath: string): unknown | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.c':
    case '.h':
      return C;
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.hxx':
    case '.hh':
      return Cpp;
    default:
      return null;
  }
}

// ---------- main class ----------

export class IncludeExtractor implements ContractExtractor {
  type = 'include' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    // 1. Build the local file list (for suffix resolution)
    const allFiles = await glob('**/*', {
      cwd: repoPath,
      ignore: STANDARD_IGNORES,
      nodir: true,
    });
    const normalizedFiles = allFiles.map((f) => f.replace(/\\/g, '/'));
    const suffixIndex = buildSuffixIndex(normalizedFiles, allFiles);

    // 2. Provider: register all header files
    const providers = await this.extractProviders(dbExecutor, repoPath, allFiles);

    // 3. Consumer: find unresolved #include directives
    const consumers = await this.extractConsumers(repoPath, normalizedFiles, allFiles, suffixIndex);

    return this.dedupe([...providers, ...consumers]);
  }

  // ---------- provider extraction ----------

  private async extractProviders(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    allFiles: string[],
  ): Promise<ExtractedContract[]> {
    // Strategy A: graph-assisted
    if (dbExecutor) {
      const graphProviders = await this.extractProvidersGraph(dbExecutor);
      if (graphProviders.length > 0) return graphProviders;
    }
    // Strategy B: filesystem fallback
    return this.extractProvidersFallback(repoPath, allFiles);
  }

  private async extractProvidersGraph(db: CypherExecutor): Promise<ExtractedContract[]> {
    try {
      const rows = await db(
        `MATCH (f:File)
         WHERE f.filePath =~ '.*\\\\.(h|hpp|hxx|hh)$'
         RETURN f.filePath AS filePath, f.id AS fileId`,
      );
      return rows
        .filter((r) => typeof r.filePath === 'string' && r.filePath)
        .map((r) => {
          const filePath = (r.filePath as string).replace(/\\/g, '/');
          return {
            contractId: `include::${normalizeIncludePath(filePath)}`,
            type: 'include' as const,
            role: 'provider' as const,
            symbolUid: String(r.fileId ?? ''),
            symbolRef: { filePath, name: path.basename(filePath) },
            symbolName: path.basename(filePath),
            confidence: 1.0,
            meta: { source: 'graph' },
          };
        });
    } catch {
      return [];
    }
  }

  private extractProvidersFallback(
    _repoPath: string,
    allFiles: string[],
  ): ExtractedContract[] {
    return allFiles
      .filter((f) => isHeaderFile(f))
      .map((f) => {
        const filePath = f.replace(/\\/g, '/');
        return {
          contractId: `include::${normalizeIncludePath(filePath)}`,
          type: 'include' as const,
          role: 'provider' as const,
          symbolUid: `File:${filePath}`,
          symbolRef: { filePath, name: path.basename(filePath) },
          symbolName: path.basename(filePath),
          confidence: 0.95,
          meta: { source: 'filesystem' },
        };
      });
  }

  // ---------- consumer extraction ----------

  private async extractConsumers(
    repoPath: string,
    normalizedFiles: string[],
    allFiles: string[],
    suffixIndex: SuffixIndex,
  ): Promise<ExtractedContract[]> {
    const sourceFiles = await glob(SOURCE_GLOB, {
      cwd: repoPath,
      ignore: STANDARD_IGNORES,
      nodir: true,
    });

    const parser = new Parser();
    const out: ExtractedContract[] = [];
    // Compile the include query once per grammar to avoid re-compilation per file
    const queryCache = new Map<unknown, Parser.Query>();

    for (const rel of sourceFiles) {
      const lang = getLanguageForFile(rel);
      if (!lang) continue;

      const content = readSafe(repoPath, rel);
      if (!content) continue;

      let query = queryCache.get(lang);
      if (!query) {
        try {
          query = new Parser.Query(lang, INCLUDE_QUERY_SRC);
          queryCache.set(lang, query);
        } catch {
          continue;
        }
      }

      // Collect raw include paths: tree-sitter first, regex fallback for large files
      let rawIncludes: string[];
      try {
        parser.setLanguage(lang);
        const tree = parser.parse(content);
        let matches: Parser.QueryMatch[];
        try {
          matches = query.matches(tree.rootNode);
        } catch {
          matches = [];
        }
        rawIncludes = [];
        for (const match of matches) {
          const sourceNode = match.captures.find((c) => c.name === 'import.source');
          if (!sourceNode) continue;
          const rawText = sourceNode.node.text;
          if (isAngleBracketInclude(rawText)) continue;
          const cleaned = rawText.replace(/['"<>]/g, '');
          if (cleaned && cleaned.length <= 2048) rawIncludes.push(cleaned);
        }
      } catch {
        // tree-sitter failed (e.g. file > 32 KB) — fall back to regex
        rawIncludes = [];
        INCLUDE_REGEX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INCLUDE_REGEX.exec(content)) !== null) {
          if (m[1] && m[1].length <= 2048) rawIncludes.push(m[1]);
        }
      }

      for (const cleaned of rawIncludes) {
        // Filter: skip known system headers and system path prefixes
        if (isSystemHeader(cleaned)) continue;

        // Local resolution: try to resolve against this repo's own files
        const pathParts = cleaned.split('/').filter(Boolean);
        const resolved = suffixResolve(pathParts, normalizedFiles, allFiles, suffixIndex);
        if (resolved !== null) continue; // Local include — not cross-repo

        // Unresolved: emit as consumer contract
        const normalizedRel = rel.replace(/\\/g, '/');
        out.push({
          contractId: `include::${normalizeIncludePath(cleaned)}`,
          type: 'include' as const,
          role: 'consumer' as const,
          symbolUid: `File:${normalizedRel}`,
          symbolRef: { filePath: normalizedRel, name: cleaned },
          symbolName: cleaned,
          confidence: 0.85,
          meta: {
            source: 'tree_sitter',
            includePath: cleaned,
          },
        });
      }
    }

    return out;
  }

  // ---------- deduplication ----------

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }
}
