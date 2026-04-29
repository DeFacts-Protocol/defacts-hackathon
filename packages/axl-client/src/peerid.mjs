/**
 * AXL peer identity helpers.
 *
 * AXL's /recv returns X-From-Peer-Id as a Yggdrasil routing identifier — a
 * 64-hex-char string consisting of a prefix of the sender's ed25519 public
 * key, followed by 0xff padding. This is the same identity space as
 * our_public_key (you address by pubkey when sending) but truncated by the
 * routing tree's prefix-matching scheme.
 *
 * Practically:
 *   pubkey:           46da0cac2173a8d36954813d5e5617abdf76cbf51bde02264698d855428ee211
 *   from-peer-id:     46da0cac2173a8d36954813d5e563fffffffffffffffffffffffffffffffffff
 *                     └── matches first 17 hex chars ──┘└── 0xff fill ──┘
 *
 * The prefix length isn't fixed — it depends on routing tree depth. We
 * accept any prefix length ≥ 16 hex chars (8 bytes / 64 bits of identity)
 * which is more than enough collision resistance for a hackathon network.
 */

const MIN_PREFIX_HEX = 16;     // 8 bytes — collision-resistant for any practical network
const PADDING_BYTE = 0xff;

/**
 * Test whether a /recv X-From-Peer-Id refers to a node with the given pubkey.
 *
 *   peerIdMatches(fromPeerId, fullPubkey) → boolean
 *
 * Returns true when:
 *   - they're byte-equal, OR
 *   - fromPeerId is a routing prefix of fullPubkey followed by 0xff padding
 *     (with matching prefix at least 8 bytes long)
 */
export function peerIdMatches(fromPeerId, fullPubkey) {
  if (typeof fromPeerId !== 'string' || typeof fullPubkey !== 'string') return false;
  const a = fromPeerId.toLowerCase();
  const b = fullPubkey.toLowerCase();

  if (a === b) return true;
  if (a.length !== b.length) return false;

  // Find longest common prefix.
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;

  if (i < MIN_PREFIX_HEX) return false;

  // Special case: AXL's truncation may zero out part of the byte where the
  // prefix ends. Walk back to the previous byte boundary if i is mid-byte.
  // (i.e. the 9th byte may have its high nibble matching but low nibble masked.)
  // Accept if at least the previous full byte boundary still has prefix match
  // and the rest of fromPeerId is all 0xff (i.e. all 'f's).
  const remainder = a.slice(i);

  // Allow: trailing all-'f', OR a single mid-byte transition followed by all-'f'.
  if (/^f+$/.test(remainder)) return true;

  // Allow one transitional hex char then all-f
  if (remainder.length >= 1 && /^[0-9a-f]f+$/.test(remainder)) {
    // The first remainder char is the transitional one. As long as everything
    // after it is 'f', we accept.
    return true;
  }

  return false;
}

/**
 * Get the canonical "routing prefix" of a from-peer-id: strip trailing 'f' fill.
 * Useful for caching/keying by sender identity.
 */
export function routingPrefix(fromPeerId) {
  if (typeof fromPeerId !== 'string') return '';
  return fromPeerId.toLowerCase().replace(/f+$/, '');
}
