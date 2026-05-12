import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IncludeExtractor } from '../../../src/core/group/extractors/include-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { normalizeContractId } from '../../../src/core/group/matching.js';

describe('IncludeExtractor', () => {
  let tmpDir: string;
  let extractor: IncludeExtractor;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-include-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    extractor = new IncludeExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  // ---- Provider detection ----

  describe('provider extraction', () => {
    it('registers .h files as providers', async () => {
      writeFile('map/base/view.h', '#pragma once\nclass View {};');
      writeFile('map/base/types.h', '#pragma once\nstruct Point {};');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(2);
      const ids = providers.map((p) => p.contractId).sort();
      expect(ids).toEqual(['include::map/base/types.h', 'include::map/base/view.h']);
      expect(providers[0].type).toBe('include');
      expect(providers[0].confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('registers .hpp files as providers', async () => {
      writeFile('utils/helper.hpp', '#pragma once\ntemplate<class T> T id(T x) { return x; }');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('include::utils/helper.hpp');
    });

    it('does not register .cpp files as providers', async () => {
      writeFile('src/main.cpp', 'int main() { return 0; }');
      writeFile('src/utils.h', '#pragma once');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('include::src/utils.h');
    });
  });

  // ---- Consumer detection ----

  describe('consumer extraction', () => {
    it('emits unresolved includes as consumers', async () => {
      writeFile(
        'src/main.cpp',
        `#include "map/base/view.h"
#include "map/base/types.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(2);
      const ids = consumers.map((c) => c.contractId).sort();
      expect(ids).toEqual(['include::map/base/types.h', 'include::map/base/view.h']);
      expect(consumers[0].type).toBe('include');
      expect(consumers[0].confidence).toBe(0.85);
    });

    it('skips locally resolved includes', async () => {
      writeFile('map/base/view.h', '#pragma once\nclass View {};');
      writeFile(
        'src/main.cpp',
        `#include "map/base/view.h"
#include "external/lib.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Only external/lib.h should be a consumer — map/base/view.h resolves locally
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::external/lib.h');
    });

    it('skips angle-bracket includes', async () => {
      writeFile(
        'src/main.cpp',
        `#include <stdio.h>
#include <vector>
#include "app/interface.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::app/interface.h');
    });

    it('skips well-known system headers in quotes', async () => {
      writeFile(
        'src/main.cpp',
        `#include "stdio.h"
#include "stdlib.h"
#include "app/config.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::app/config.h');
    });

    it('skips system path prefixes', async () => {
      writeFile(
        'src/main.c',
        `#include "sys/types.h"
#include "linux/input.h"
#include "mylib/types.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::mylib/types.h');
    });
  });

  // ---- Cross-repo matching scenario ----

  describe('cross-repo matching', () => {
    it('provider and consumer produce matching contractIds', async () => {
      // Simulate provider repo (header-only)
      const providerDir = path.join(os.tmpdir(), `gitnexus-include-provider-${Date.now()}`);
      fs.mkdirSync(providerDir, { recursive: true });
      const providerFile = path.join(providerDir, 'map/base/dice_map_view.h');
      fs.mkdirSync(path.dirname(providerFile), { recursive: true });
      fs.writeFileSync(providerFile, '#pragma once\nclass DiceMapView {};');

      // Simulate consumer repo
      const consumerDir = path.join(os.tmpdir(), `gitnexus-include-consumer-${Date.now()}`);
      fs.mkdirSync(consumerDir, { recursive: true });
      const consumerFile = path.join(consumerDir, 'src/controller.cpp');
      fs.mkdirSync(path.dirname(consumerFile), { recursive: true });
      fs.writeFileSync(consumerFile, '#include "map/base/dice_map_view.h"\nvoid init() {}');

      try {
        const providerContracts = await extractor.extract(null, providerDir, makeRepo(providerDir));
        const consumerContracts = await extractor.extract(null, consumerDir, makeRepo(consumerDir));

        const providers = providerContracts.filter((c) => c.role === 'provider');
        const consumers = consumerContracts.filter((c) => c.role === 'consumer');

        expect(providers.length).toBeGreaterThanOrEqual(1);
        expect(consumers.length).toBeGreaterThanOrEqual(1);

        const providerIds = new Set(providers.map((p) => normalizeContractId(p.contractId)));
        const consumerIds = consumers.map((c) => normalizeContractId(c.contractId));

        // The consumer's include path should match a provider's file path
        expect(providerIds.has(consumerIds[0])).toBe(true);
      } finally {
        fs.rmSync(providerDir, { recursive: true, force: true });
        fs.rmSync(consumerDir, { recursive: true, force: true });
      }
    });
  });

  // ---- Deduplication ----

  describe('deduplication', () => {
    it('deduplicates same include from multiple source files', async () => {
      writeFile('src/a.cpp', '#include "ext/api.h"\nvoid a() {}');
      writeFile('src/b.cpp', '#include "ext/api.h"\nvoid b() {}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Both files include "ext/api.h" — each should produce a separate
      // consumer contract (different symbolRef.filePath)
      expect(consumers).toHaveLength(2);
      const files = consumers.map((c) => c.symbolRef.filePath).sort();
      expect(files).toEqual(['src/a.cpp', 'src/b.cpp']);
    });
  });

  // ---- normalizeContractId ----

  describe('normalizeContractId for include', () => {
    it('lowercases the path', () => {
      expect(normalizeContractId('include::Map/Base/Foo.h')).toBe('include::map/base/foo.h');
    });

    it('normalizes backslashes', () => {
      expect(normalizeContractId('include::map\\base\\foo.h')).toBe('include::map/base/foo.h');
    });

    it('strips leading ./', () => {
      expect(normalizeContractId('include::./foo.h')).toBe('include::foo.h');
    });

    it('collapses consecutive slashes', () => {
      expect(normalizeContractId('include::map//base///foo.h')).toBe('include::map/base/foo.h');
    });
  });
});
