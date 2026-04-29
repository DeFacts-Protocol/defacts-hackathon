/**
 * The six DeFacts protocol method names.
 *
 * Per Apr 28 decision log:
 *   defacts.query            — buyer broadcasts query, looking for bids   (/send)
 *   defacts.bid              — agent responds with price + receipt CID    (/send)
 *   defacts.accept            — buyer accepts a specific bid              (/a2a, sync)
 *   defacts.deliver           — agent delivers receipt + attestation     (/a2a, sync)
 *   defacts.settle_request    — buyer notifies agent payment is on-chain (/a2a, sync)
 *   defacts.settle_complete   — agent confirms settlement seen           (/a2a, sync)
 *
 * Two transports:
 *   /send  — fire-and-forget broadcast-ish gossip. Used for query/bid where
 *            the buyer doesn't know in advance which agents will respond.
 *   /a2a   — synchronous request/response with 30s timeout. Used for the
 *            bilateral handshake once a specific agent is selected.
 */

export const METHODS = Object.freeze({
  QUERY:           'defacts.query',
  BID:             'defacts.bid',
  ACCEPT:          'defacts.accept',
  DELIVER:         'defacts.deliver',
  SETTLE_REQUEST:  'defacts.settle_request',
  SETTLE_COMPLETE: 'defacts.settle_complete',
});

// Methods that travel over /send (gossip, async, may have multiple responses)
export const GOSSIP_METHODS = Object.freeze([
  METHODS.QUERY,
  METHODS.BID,
]);

// Methods that travel over /a2a (sync, point-to-point, single response)
export const A2A_METHODS = Object.freeze([
  METHODS.ACCEPT,
  METHODS.DELIVER,
  METHODS.SETTLE_REQUEST,
  METHODS.SETTLE_COMPLETE,
]);

export function isValidMethod(name) {
  return Object.values(METHODS).includes(name);
}
