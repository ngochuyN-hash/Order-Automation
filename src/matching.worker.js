/**
 * =========================================================================
 *  ORDER AUTOMATION - WEB WORKER (ES Module version for Vite bundling)
 * =========================================================================
 *  Background thread for non-blocking parsing and matching.
 *  Imports shared logic from parser.js via ES module imports.
 * =========================================================================
 */

import { normalizeText, findBestProductMatch as _baseFindBestProductMatch, parseOrderText } from '../parser.js';

let cachedProducts = [];
let cachedAliases = {};
let cachedKvCodes = {}; // kvCode (lowercase) → product

// Enhanced findBestProductMatch with kvCode lookup support
function findBestProductMatch(rawText, allProducts, aliases) {
  if (!rawText || rawText.trim().length === 0) return null;

  // Try kvCode match first
  const normalized = normalizeText(rawText);
  if (normalized) {
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const rawTokens = rawText.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
    for (const token of [...tokens, ...rawTokens]) {
      const tokenLower = token.toLowerCase();
      if (cachedKvCodes[tokenLower]) {
        return { product: cachedKvCodes[tokenLower], score: 98 };
      }
    }
  }

  // Fall back to base matching logic
  return _baseFindBestProductMatch(rawText, allProducts, aliases);
}

// --- Message Listener ---

self.onmessage = function (e) {
  const { type, payload, requestId } = e.data;

  if (type === 'INIT_DB' || type === 'UPDATE_DB') {
    cachedProducts = payload.products || [];
    cachedAliases = payload.aliases || {};
    // Build KV code lookup
    cachedKvCodes = {};
    for (const p of cachedProducts) {
      if (p.kvCode) cachedKvCodes[p.kvCode.toLowerCase()] = p;
    }
    self.postMessage({ type: 'STATUS', status: 'ready', requestId });
  } else if (type === 'PARSE') {
    try {
      const result = parseOrderText(payload.text, cachedProducts, cachedAliases);
      self.postMessage({
        type: 'PARSE_RESULT',
        payload: result,
        requestId
      });
    } catch (err) {
      self.postMessage({
        type: 'PARSE_ERROR',
        error: err.message,
        requestId
      });
    }
  }
};
