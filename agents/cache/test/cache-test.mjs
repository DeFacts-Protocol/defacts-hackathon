/**
 * CacheStore unit tests. No external dependencies.
 *
 * Run with:  node test/cache-test.mjs
 */

import { CacheStore } from '../src/cache.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function expect(label, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}`, detail || ''); }
}

// Setup: create a temp fixtures directory
const dir = await mkdtemp(join(tmpdir(), 'cache-test-'));

// Write 3 fixtures: one with explicit _prompt_label, one without, one malformed
await writeFile(join(dir, 'with-label.json'), JSON.stringify({
  _prompt_label: 'explicit-label',
  det_hash: '0xaa',
  proof_format: 'stub-v1',
}));
await writeFile(join(dir, 'fallback-label.json'), JSON.stringify({
  det_hash: '0xbb',
  proof_format: 'stub-v1',
}));
await writeFile(join(dir, 'broken.json'), '{invalid json');
await writeFile(join(dir, 'ignored.txt'), 'not json');

const cache = new CacheStore();
const loaded = await cache.loadFromDir(dir);

expect('loaded count', loaded === 2, `got ${loaded}`);  // broken.json + ignored.txt should skip
expect('size', cache.size() === 2);

// Explicit label
expect('has explicit-label', cache.has('explicit-label'));
const r1 = cache.get('explicit-label');
expect('explicit-label receipt has det_hash', r1?.det_hash === '0xaa');
expect('_prompt_label not leaked into receipt', r1?._prompt_label === undefined);

// Filename fallback
expect('has fallback-label', cache.has('fallback-label'));
const r2 = cache.get('fallback-label');
expect('fallback-label receipt has det_hash', r2?.det_hash === '0xbb');

// Misses
expect('missing label returns undefined', cache.get('does-not-exist') === undefined);
expect('has missing label is false', cache.has('does-not-exist') === false);

// Labels list
const labels = cache.labels();
expect('labels contain both', labels.includes('explicit-label') && labels.includes('fallback-label'));

// Cleanup
await rm(dir, { recursive: true });

// Empty dir
const emptyDir = await mkdtemp(join(tmpdir(), 'cache-empty-'));
const emptyCache = new CacheStore();
expect('empty dir loads zero', (await emptyCache.loadFromDir(emptyDir)) === 0);
expect('empty cache size', emptyCache.size() === 0);
await rm(emptyDir, { recursive: true });

// Nonexistent dir
const nonexistent = new CacheStore();
let threw = false;
try { await nonexistent.loadFromDir('/this/path/does/not/exist'); }
catch (e) { threw = true; }
expect('nonexistent dir throws', threw);

console.log('');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
