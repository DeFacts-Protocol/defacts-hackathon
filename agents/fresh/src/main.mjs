#!/usr/bin/env node
/**
 * fresh-mode-agent CLI entrypoint.
 *
 * Reads config from environment:
 *   AXL_API_BASE       AXL HTTP API base       (default: http://localhost:9202)
 *   PROVER_ENDPOINT    Prover URL              (default: http://localhost:7001)
 *                      Day 5: point at PD19 endpoints (l4 / l40s / h100)
 *   VERIFIER_URL       verifier-stub URL       (default: http://localhost:7002)
 *   AGENT_ID           our identity            (default: fresh-001)
 *   PRICE_WEI          what we bid             (default: 200000000000000)
 *                      Higher than cache-001 because fresh costs real GPU time.
 *
 * Prints "FRESH_AGENT_READY" once listening so test harnesses can wait.
 */

import { FreshModeAgent } from './runtime.mjs';

const agent = new FreshModeAgent({
  axlApiBase:     process.env.AXL_API_BASE     || 'http://localhost:9202',
  proverEndpoint: process.env.PROVER_ENDPOINT  || 'http://localhost:7001',
  verifierUrl:    process.env.VERIFIER_URL     || 'http://localhost:7002',
  agentId:        process.env.AGENT_ID         || 'fresh-001',
  priceWei:       process.env.PRICE_WEI        || '200000000000000',  // 0.0002 ETH default
});

await agent.start();
console.log('FRESH_AGENT_READY');

process.on('SIGINT',  async () => { await agent.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await agent.stop(); process.exit(0); });
