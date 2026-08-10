/**
 * youtubeDiscoveryRefresh.js
 *
 * Orchestrator for the YouTube-powered Home discovery background refresh.
 *
 * Responsibilities:
 *  1. Fetch YouTube candidates (youtubeDiscoveryService)
 *  2. Match each to JioSaavn (discoveryMatcher → importMatcherService)
 *  3. Store validated, ranked candidates in MongoDB (YoutubeDiscoveryCache)
 *  4. Log detailed stats for every refresh run
 *
 * Called by:
 *  - backend/worker/fetcher.js (every 6 hours via node-cron)
 *  - backend/routes/home-enhanced.js (POST /api/home/refresh — admin trigger)
 *
 * Safety guarantees:
 *  - If YOUTUBE_DISCOVERY_ENABLED !== 'true', the function returns immediately.
 *  - If YOUTUBE_API_KEY is missing, the function returns with a warning.
 *  - A run-lock prevents concurrent executions.
 *  - Any error during fetch/match/store is caught and logged; the existing
 *    MongoDB cache is NEVER cleared on failure.
 *  - The existing JioSaavn Home routes (/api/trending, /api/new-releases) are
 *    completely unaffected by any failure here.
 */

'use strict';

const mongoose = require('mongoose');
const YoutubeDiscoveryCache = require('../models/YoutubeDiscoveryCache');
const { fetchAllDiscoveryCandidates } = require('./youtubeDiscoveryService');
const { matchDiscoveryCandidates } = require('./discoveryMatcher');

// ─── Config ───────────────────────────────────────────────────────────────────

const YOUTUBE_API_KEY          = process.env.YOUTUBE_API_KEY || '';
const DISCOVERY_ENABLED        = process.env.YOUTUBE_DISCOVERY_ENABLED === 'true';
const CACHE_TTL_HOURS          = parseFloat(process.env.DISCOVERY_REFRESH_INTERVAL_HOURS || '6');
const CACHE_TTL_MS             = CACHE_TTL_HOURS * 60 * 60 * 1000;

// How long before the cache expires to trigger a refresh (10 minutes grace)
const REFRESH_GRACE_MS = 10 * 60 * 1000;

// ─── Run lock (prevents concurrent refresh jobs) ──────────────────────────────

let _isRefreshing = false;
let _lastRefreshAt = 0;

function isMongoAvailable() {
  return mongoose.connection.readyState === 1;
}

// ─── Upsert a single section into MongoDB ────────────────────────────────────

async function upsertSectionCache(sectionType, songs, stats, durationMs) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (CACHE_TTL_HOURS + 2) * 60 * 60 * 1000);

  const update = {
    songs,
    refreshedAt:          now,
    expiresAt,
    totalYoutubeItems:    stats.totalInput,
    totalMatched:         stats.totalMatched,
    totalRejected:        stats.totalRejected,
    totalDuplicates:      stats.totalDuplicates,
    refreshDurationMs:    durationMs,
  };

  await YoutubeDiscoveryCache.findOneAndUpdate(
    { sectionType },
    { $set: update },
    { upsert: true, new: true }
  );

  console.log(
    `[YTDiscoveryRefresh] Upserted section="${sectionType}":` +
    ` songs=${songs.length} matched=${stats.totalMatched}` +
    ` rejected=${stats.totalRejected} dupes=${stats.totalDuplicates}`
  );
}

// ─── Main refresh function ────────────────────────────────────────────────────

/**
 * Run a full YouTube discovery refresh cycle.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Skip the TTL check, always refresh
 * @returns {Promise<{
 *   success: boolean,
 *   skipped: boolean,
 *   reason?: string,
 *   sections?: object,
 *   durationMs?: number,
 * }>}
 */
async function runDiscoveryRefresh(options) {
  options = options || {};

  // ── Feature flag check ────────────────────────────────────────────────────
  if (!DISCOVERY_ENABLED) {
    console.log('[YTDiscoveryRefresh] Skipped — YOUTUBE_DISCOVERY_ENABLED is not "true"');
    return { success: true, skipped: true, reason: 'feature_disabled' };
  }

  // ── API key check ─────────────────────────────────────────────────────────
  if (!YOUTUBE_API_KEY) {
    console.warn('[YTDiscoveryRefresh] Skipped — YOUTUBE_API_KEY env var is not set');
    return { success: true, skipped: true, reason: 'no_api_key' };
  }

  // ── MongoDB check ─────────────────────────────────────────────────────────
  if (!isMongoAvailable()) {
    console.warn('[YTDiscoveryRefresh] Skipped — MongoDB is not connected');
    return { success: false, skipped: true, reason: 'mongodb_unavailable' };
  }

  // ── TTL check: skip if last refresh was recent (unless forced) ────────────
  if (!options.force) {
    const elapsed = Date.now() - _lastRefreshAt;
    if (elapsed < CACHE_TTL_MS - REFRESH_GRACE_MS) {
      const nextRefreshIn = Math.round((CACHE_TTL_MS - REFRESH_GRACE_MS - elapsed) / 60000);
      console.log(`[YTDiscoveryRefresh] Skipped — next refresh in ${nextRefreshIn} min`);
      return { success: true, skipped: true, reason: 'not_due_yet' };
    }
  }

  // ── Run lock ──────────────────────────────────────────────────────────────
  if (_isRefreshing) {
    console.log('[YTDiscoveryRefresh] Skipped — refresh already in progress');
    return { success: true, skipped: true, reason: 'already_running' };
  }

  _isRefreshing = true;
  const refreshStartMs = Date.now();

  console.log('[YTDiscoveryRefresh] ─── Starting refresh cycle ───');

  try {
    // ── Step 1: Fetch YouTube candidates ─────────────────────────────────────
    const ytCandidates = await fetchAllDiscoveryCandidates(YOUTUBE_API_KEY);

    // Section types we process in this refresh
    const sections = ['trending', 'malayalam', 'tamil', 'hindi'];
    const sectionResults = {};

    for (const section of sections) {
      const items = ytCandidates[section] || [];
      const sectionStart = Date.now();

      console.log(`[YTDiscoveryRefresh] Processing section="${section}" with ${items.length} YouTube items`);

      if (items.length === 0) {
        console.warn(`[YTDiscoveryRefresh] No YouTube items for section="${section}" — skipping upsert`);
        sectionResults[section] = { skipped: true, songs: 0 };
        continue;
      }

      try {
        // ── Step 2: Match to JioSaavn ─────────────────────────────────────
        const { songs, stats } = await matchDiscoveryCandidates(items);

        const sectionDuration = Date.now() - sectionStart;

        // ── Step 3: Store to MongoDB ──────────────────────────────────────
        if (songs.length > 0) {
          await upsertSectionCache(section, songs, stats, sectionDuration);
        } else {
          console.warn(
            `[YTDiscoveryRefresh] section="${section}": 0 matched songs — ` +
            'MongoDB cache NOT updated (preserving last good cache)'
          );
        }

        sectionResults[section] = {
          skipped:    false,
          songs:      songs.length,
          stats,
          durationMs: sectionDuration,
        };
      } catch (sectionErr) {
        console.error(
          `[YTDiscoveryRefresh] Error processing section="${section}": ${sectionErr.message}`
        );
        sectionResults[section] = { skipped: true, songs: 0, error: sectionErr.message };
        // Continue with other sections — one section failure doesn't abort the whole refresh
      }
    }

    const totalDuration = Date.now() - refreshStartMs;
    _lastRefreshAt = Date.now();

    console.log(
      `[YTDiscoveryRefresh] ─── Refresh complete in ${totalDuration}ms ───\n` +
      Object.entries(sectionResults)
        .map(([s, r]) => `  ${s}: ${r.skipped ? 'SKIPPED' : r.songs + ' songs'}`)
        .join('\n')
    );

    return {
      success:     true,
      skipped:     false,
      sections:    sectionResults,
      durationMs:  totalDuration,
    };
  } catch (err) {
    console.error(`[YTDiscoveryRefresh] Fatal error during refresh: ${err.message}`, err);
    return {
      success:   false,
      skipped:   false,
      error:     err.message,
      durationMs: Date.now() - refreshStartMs,
    };
  } finally {
    _isRefreshing = false;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function getRefreshStatus() {
  return {
    enabled:       DISCOVERY_ENABLED,
    hasApiKey:     !!YOUTUBE_API_KEY,
    isRefreshing:  _isRefreshing,
    lastRefreshAt: _lastRefreshAt > 0 ? new Date(_lastRefreshAt).toISOString() : null,
    cacheTtlHours: CACHE_TTL_HOURS,
  };
}

module.exports = {
  runDiscoveryRefresh,
  getRefreshStatus,
};
