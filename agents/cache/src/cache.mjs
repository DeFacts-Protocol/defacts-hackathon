/**
 * CacheStore — loads receipt fixtures from disk and exposes lookup by
 * prompt_label. The cache is the supplier's "inventory": pre-computed
 * receipts the agent can re-sell on demand.
 *
 * Each fixture file is a JSON receipt at minimum. The file's prompt_label
 * key is taken from the file's `_prompt_label` field (or the filename
 * without extension if that field is absent).
 *
 * Cache hit-rate is the supplier's primary economic moat: the more queries
 * resolve from cache, the lower the marginal cost per bid (no fresh GPU
 * inference required). The first buyer of a fresh receipt funds the
 * computation; every subsequent buyer pays a fraction for the same receipt.
 * That's "the proof is a capital good" — directly visible at the cache layer.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

export class CacheStore {
  constructor() {
    this.byLabel = new Map();   // prompt_label → receipt
  }

  async loadFromDir(dir) {
    let entries;
    try { entries = await readdir(dir); }
    catch (e) { throw new Error(`CacheStore: cannot read fixtures dir ${dir}: ${e.message}`); }

    let loaded = 0;
    for (const filename of entries) {
      if (extname(filename) !== '.json') continue;
      const path = join(dir, filename);
      let raw, parsed;
      try {
        raw = await readFile(path, 'utf8');
        parsed = JSON.parse(raw);
      } catch (e) {
        console.warn(`[cache] skipping ${filename}: ${e.message}`);
        continue;
      }
      const label = parsed._prompt_label || basename(filename, '.json');
      const receipt = { ...parsed };
      delete receipt._prompt_label;  // keep receipt clean for verifier-stub
      this.byLabel.set(label, receipt);
      loaded++;
    }
    return loaded;
  }

  has(promptLabel) {
    return this.byLabel.has(promptLabel);
  }

  get(promptLabel) {
    return this.byLabel.get(promptLabel);
  }

  size() {
    return this.byLabel.size;
  }

  labels() {
    return Array.from(this.byLabel.keys());
  }
}
