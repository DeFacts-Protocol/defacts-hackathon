#!/usr/bin/env node
/**
 * cache-mode-agent CLI entrypoint.
 *
 * Reads config from environment:
 *   AXL_API_BASE      AXL HTTP API base (default: http://localhost:9202)
 *   VERIFIER_URL      verifier-stub URL  (default: http://localhost:7002)
 *   AGENT_ID          our application-layer identity (default: cache-001)
 *   PRICE_WEI         what we bid                    (default: 50000000000000)
 *   FIXTURES_DIR      receipts to load               (default: ./fixtures)
 *
 * Prints "CACHE_AGENT_READY" once it's listening so test harnesses can wait.
 *
 * Stays alive until SIGINT/SIGTERM.
 */

import { CacheModeAgent } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const agent = new CacheModeAgent({
  axlApiBase:  process.env.AXL_API_BASE || 'http://localhost:9202',
  verifierUrl: process.env.VERIFIER_URL || 'http://localhost:7002',
  agentId:     process.env.AGENT_ID     || 'cache-001',
  priceWei:    process.env.PRICE_WEI    || '50000000000000',  // 0.00005 ETH default
  fixturesDir: process.env.FIXTURES_DIR || join(__dirname, '..', 'fixtures'),
});

await agent.start();
console.log('CACHE_AGENT_READY');

process.on('SIGINT',  async () => { await agent.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await agent.stop(); process.exit(0); });
