/**
 * home-enhanced.js
 *
 * Backend routes for the YouTube-powered Home discovery enhancement.
 *
 * Routes:
 *   GET  /api/home/trending-enhanced   — Main endpoint; returns YouTube-enhanced trending
 *   GET  /api/home/status              — Diagnostic: cache status, config, last refresh
 *   POST /api/home/refresh             — Admin-only manual refresh trigger
 *
 * ARCHITECTURE:
 *   All responses return data in the same song-object shape as /api/trending.
 *   The frontend is unaware of YouTube — it just receives clean JioSaavn songs.
 *
 * FALLBACK CHAIN:
 *   1. MongoDB youtube_discovery_cache (if valid and within TTL)
 *   2. Existing /api/trending JioSaavn endpoint (if cache unavailable or empty)
 *   3. Empty array (final safety net — should never be reached in practice)
 *
 * The existing /api/trending route is completely unchanged and unaffected.
 */

'use strict';

const express = require('express');
const axios   = require('axios');
const mongoose = require('mongoose');

const router = express.Router();

// ─── Lazy-load discovery models/services (safe if MongoDB is down) ────────────

let YoutubeDiscoveryCache;
let youtubeDiscoveryRefresh;

try {
  YoutubeDiscoveryCache   = require('../models/YoutubeDiscoveryCache');
  youtubeDiscoveryRefresh = require('../services/youtubeDiscoveryRefresh');
} catch (e) {
  console.warn('[HomeEnhanced] Could not load discovery modules:', e.message);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const DISCOVERY_ENABLED = process.env.YOUTUBE_DISCOVERY_ENABLED === 'true';
const CACHE_TTL_HOURS   = parseFloat(process.env.DISCOVERY_REFRESH_INTERVAL_HOURS || '6');
const CACHE_TTL_MS      = CACHE_TTL_HOURS * 60 * 60 * 1000;

// Max songs to return (matches frontend MAX_EXPANDED = 30)
const MAX_TRENDING_SONGS = 30;

// Internal URL for the existing JioSaavn trending endpoint (fallback)
const JIOSAAVN_TRENDING_URL =
  `http://127.0.0.1:${process.env.PORT || 5009}/api/trending`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMongAvailable() {
  return mongoose.connection.readyState === 1;
}

/**
 * Fetch songs from the existing /api/trending endpoint as a fallback.
 * If that fails, returns an empty array.
 *
 * The existing trending route is NOT modified — we just HTTP-call it.
 */
async function fetchJioSaavnTrendingFallback(limit) {
  try {
    const resp = await axios.get(JIOSAAVN_TRENDING_URL, {
      params: { limit: limit || MAX_TRENDING_SONGS },
      timeout: 15000,
    });
    // /api/trending returns { songs: [...] }
    const songs = (resp.data && resp.data.songs) || (Array.isArray(resp.data) ? resp.data : []);
    return songs;
  } catch (err) {
    console.warn(`[HomeEnhanced] Fallback to /api/trending failed: ${err.message}`);
    return [];
  }
}

/**
 * Convert a discovered song (from YoutubeDiscoveryCache) into the
 * same shape the frontend expects from /api/trending.
 *
 * This ensures HomeView.tsx and TrendingSongsSection can consume the
 * enhanced endpoint without any frontend changes.
 */
function toFrontendSong(ds, backendOrigin) {
  const rewriteUrl = (arr) => {
    if (!arr || !Array.isArray(arr)) return arr;
    return arr.map(item => {
      if (item.link && item.link.startsWith('/api/')) {
        return { ...item, link: backendOrigin + item.link };
      }
      return item;
    });
  };

  return {
    id:             ds.jiosaavnId,
    name:           ds.name,
    album:          ds.album || { id: '', name: '', url: '' },
    year:           ds.year || '',
    releaseDate:    ds.releaseDate || '',
    duration:       ds.duration || 0,
    primaryArtists: ds.primaryArtists || '',
    language:       ds.language || '',
    playCount:      ds.playCount || 0,
    hasLyrics:      ds.hasLyrics || false,
    image:          rewriteUrl(ds.image) || [],
    downloadUrl:    rewriteUrl(ds.downloadUrl) || [],
    url:            ds.url || '',
    explicitContent: ds.explicitContent || false,
    // Discovery-specific fields (frontend ignores these but useful for debug)
    _discoveryScore:    ds.discoveryScore,
    _youtubeViewCount:  ds.youtubeViewCount,
    _confidence:        ds.confidence,
  };
}

// ─── GET /api/home/trending-enhanced ─────────────────────────────────────────

/**
 * Returns YouTube-enhanced trending songs.
 *
 * Data is served from the MongoDB discovery cache.
 * If the cache is unavailable, stale, or empty, falls back to /api/trending.
 *
 * Query params:
 *   limit  {number}  Max songs to return (default: 30)
 *   lang   {string}  Optional language filter: 'malayalam', 'tamil', 'hindi'
 *                    If omitted, returns 'trending' section.
 */
router.get('/trending-enhanced', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || String(MAX_TRENDING_SONGS), 10), 50);
  const lang   = req.query.lang || 'trending';

  // Map lang param to our section types
  const VALID_SECTIONS = ['trending', 'malayalam', 'tamil', 'hindi', 'new_releases', 'english'];
  const sectionType = VALID_SECTIONS.includes(lang) ? lang : 'trending';

  // ── Check if discovery is enabled and MongoDB is available ────────────────
  const canUseDiscovery = DISCOVERY_ENABLED && YoutubeDiscoveryCache && isMongAvailable();

  if (!canUseDiscovery) {
    // Feature disabled or MongoDB down — transparent fallback
    const songs = await fetchJioSaavnTrendingFallback(limit);
    return res.json({
      success:    true,
      source:     'jiosaavn_fallback',
      reason:     !DISCOVERY_ENABLED ? 'feature_disabled' : 'mongodb_unavailable',
      songs:      songs.slice(0, limit),
      count:      Math.min(songs.length, limit),
    });
  }

  // ── Try the MongoDB discovery cache ───────────────────────────────────────
  let cacheDoc;
  try {
    cacheDoc = await YoutubeDiscoveryCache.findOne({ sectionType }).lean();
  } catch (mongoErr) {
    console.error(`[HomeEnhanced] MongoDB read error: ${mongoErr.message}`);
    cacheDoc = null;
  }

  const now = Date.now();
  const cacheAge = cacheDoc && cacheDoc.refreshedAt
    ? now - new Date(cacheDoc.refreshedAt).getTime()
    : Infinity;
  const isCacheValid = cacheDoc && cacheDoc.songs && cacheDoc.songs.length > 0
    && cacheAge < CACHE_TTL_MS;

  if (isCacheValid) {
    const backendOrigin = process.env.BACKEND_PUBLIC_URL || (req.protocol + '://' + req.get('host'));

    // ── Serve from cache ────────────────────────────────────────────────────
    const songs = cacheDoc.songs
      .slice(0, limit)
      .map(s => toFrontendSong(s, backendOrigin));

    return res.json({
      success:          true,
      source:           'youtube_discovery_cache',
      sectionType,
      refreshedAt:      cacheDoc.refreshedAt,
      cacheAgeMinutes:  Math.round(cacheAge / 60000),
      songs,
      count:            songs.length,
    });
  }

  // ── Cache empty or stale — fall back to JioSaavn ─────────────────────────
  console.log(
    `[HomeEnhanced] Cache miss for section="${sectionType}" ` +
    `(valid=${isCacheValid}, age=${Math.round(cacheAge/60000)}min)`
  );

  // Trigger async background refresh if cache is stale (non-blocking)
  if (youtubeDiscoveryRefresh && cacheDoc) {
    setImmediate(() => {
      youtubeDiscoveryRefresh.runDiscoveryRefresh({ force: false }).catch(err => {
        console.error('[HomeEnhanced] Background refresh error:', err.message);
      });
    });
  }

  const fallbackSongs = await fetchJioSaavnTrendingFallback(limit);
  return res.json({
    success:    true,
    source:     'jiosaavn_fallback',
    reason:     isCacheValid === false ? 'cache_stale' : 'cache_empty',
    sectionType,
    songs:      fallbackSongs.slice(0, limit),
    count:      Math.min(fallbackSongs.length, limit),
  });
});

// ─── GET /api/home/status ─────────────────────────────────────────────────────

/**
 * Diagnostic endpoint.
 * Returns: discovery config, refresh status, cache state per section.
 * Does NOT require authentication (safe — returns no private data).
 */
router.get('/status', async (req, res) => {
  const status = {
    discovery: {
      enabled:     DISCOVERY_ENABLED,
      hasApiKey:   !!(process.env.YOUTUBE_API_KEY),
      cacheTtlHours: CACHE_TTL_HOURS,
    },
    mongodb: {
      connected:   isMongAvailable(),
      readyState:  mongoose.connection.readyState,
    },
    refreshStatus: youtubeDiscoveryRefresh
      ? youtubeDiscoveryRefresh.getRefreshStatus()
      : null,
    sections: {},
  };

  if (isMongAvailable() && YoutubeDiscoveryCache) {
    try {
      const docs = await YoutubeDiscoveryCache.find({}, {
        sectionType: 1,
        refreshedAt: 1,
        expiresAt:   1,
        totalYoutubeItems: 1,
        totalMatched: 1,
        totalRejected: 1,
        totalDuplicates: 1,
        refreshDurationMs: 1,
        'songs': { $slice: 0 },  // Don't return songs array here
      }).lean();

      const now = Date.now();
      for (const doc of docs) {
        status.sections[doc.sectionType] = {
          refreshedAt:      doc.refreshedAt,
          expiresAt:        doc.expiresAt,
          cacheAgeMinutes:  doc.refreshedAt
            ? Math.round((now - new Date(doc.refreshedAt).getTime()) / 60000)
            : null,
          totalYoutubeItems:   doc.totalYoutubeItems,
          totalMatched:        doc.totalMatched,
          totalRejected:       doc.totalRejected,
          totalDuplicates:     doc.totalDuplicates,
          refreshDurationMs:   doc.refreshDurationMs,
        };
      }
    } catch (e) {
      status.sections._error = e.message;
    }
  }

  res.json(status);
});

// ─── POST /api/home/refresh ───────────────────────────────────────────────────

/**
 * Admin-only manual trigger for the discovery refresh job.
 *
 * Requires:
 *   Authorization: Bearer <ADMIN_SECRET>  (ADMIN_SECRET env var)
 *
 * Body (optional):
 *   { "force": true }  — skip TTL check
 */
router.post('/refresh', async (req, res) => {
  // Simple auth: match ADMIN_SECRET env var
  const adminSecret = process.env.ADMIN_SECRET || '';
  if (!adminSecret) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_SECRET is not configured — manual refresh is disabled',
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token !== adminSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (!youtubeDiscoveryRefresh) {
    return res.status(503).json({
      success: false,
      error: 'Discovery refresh module is not loaded',
    });
  }

  const force = !!(req.body && req.body.force);

  console.log(`[HomeEnhanced] Manual refresh triggered (force=${force})`);

  // Run in background — return immediately with 202 Accepted
  res.status(202).json({
    success: true,
    message: 'Discovery refresh started in background',
    force,
  });

  // Kick off refresh after response is sent
  setImmediate(async () => {
    try {
      const result = await youtubeDiscoveryRefresh.runDiscoveryRefresh({ force });
      console.log('[HomeEnhanced] Manual refresh result:', JSON.stringify(result));
    } catch (err) {
      console.error('[HomeEnhanced] Manual refresh failed:', err.message);
    }
  });
});

module.exports = router;
