/**
 * youtubeDiscoveryService.js
 *
 * YouTube Data API v3 client for the Home discovery system.
 *
 * IMPORTANT:
 *  - Uses a server-side API key (YOUTUBE_API_KEY env var), NOT OAuth.
 *  - The existing youtubeService.js uses OAuth for playlist import — NOT used here.
 *  - This service only calls PUBLIC read-only endpoints.
 *  - Called ONLY by the background refresh job (every 6 hours).
 *  - NEVER called on a per-user-request basis.
 *  - The API key is NEVER returned to the frontend.
 *
 * Discovery queries used:
 *  - videos.list?chart=mostPopular&videoCategoryId=10&regionCode=IN  (1 unit)
 *  - videos.list?chart=mostPopular&videoCategoryId=10                (1 unit)
 *  - search.list?q=...&videoCategoryId=10&order=relevance            (100 units each)
 *
 * Music category ID:  10  (YouTube "Music" category — constant across regions)
 * Max 50 results per request (YouTube API hard limit for videos.list)
 * Max 50 results per request for search.list
 *
 * Quota estimates (4 refreshes/day):
 *  - 2 videos.list calls × 4 = 8 units
 *  - 4 search.list calls × 4 = 1,600 units
 *  - Total: ~1,608 / 10,000 daily limit
 */

'use strict';

const axios = require('axios');

// ─── Constants ────────────────────────────────────────────────────────────────

const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const MUSIC_CATEGORY_ID = '10';

// Minimum video duration to be considered a music track (not a short/promo)
const MIN_DURATION_SECONDS = 90; // 1 min 30 s

// Maximum videos to pull per query (YouTube's hard limit is 50)
const MAX_RESULTS_PER_QUERY = 50;

// Regional queries for South Asian music discovery
const REGIONAL_QUERIES = [
  { lang: 'malayalam', query: 'new malayalam movie songs 2026 2025', section: 'malayalam' },
  { lang: 'tamil',     query: 'new tamil movie songs 2026 2025',     section: 'tamil'     },
  { lang: 'hindi',     query: 'new hindi bollywood songs 2026 2025', section: 'hindi'     },
];

// ─── Parse ISO 8601 duration to seconds (e.g. PT3M45S → 225) ─────────────────

function iso8601DurationToSeconds(str) {
  if (!str) return 0;
  const match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  return h * 3600 + m * 60 + s;
}

// ─── Normalise a raw YouTube video item to a discovery-ready object ───────────

function normalizeYouTubeItem(video) {
  const snippet     = video.snippet || {};
  const contentDets = video.contentDetails || {};
  const statistics  = video.statistics || {};

  const durationSec = iso8601DurationToSeconds(contentDets.duration || '');
  const viewCount   = parseInt(statistics.viewCount || '0', 10);

  return {
    videoId:     video.id || '',
    title:       snippet.title || '',
    channelTitle: snippet.channelTitle || '',
    publishedAt:  snippet.publishedAt ? new Date(snippet.publishedAt) : null,
    durationSec,
    viewCount,
    // Raw thumbnail (not exposed to frontend — internal use only)
    thumbnailUrl: (snippet.thumbnails && (snippet.thumbnails.high || snippet.thumbnails.medium || snippet.thumbnails.default) || {}).url || '',
  };
}

// ─── Filter: reject videos that are almost certainly not music releases ────────

function isValidMusicVideo(item) {
  // Must meet minimum duration
  if (item.durationSec < MIN_DURATION_SECONDS) return false;

  const titleLc = (item.title || '').toLowerCase();

  // Reject obvious non-music content
  const NON_MUSIC_MARKERS = [
    'trailer', 'teaser', 'interview', 'behind the scenes',
    'bts', 'making of', 'reaction', 'review', 'podcast',
    'live concert', 'full concert', 'news', 'promo',
    'devotional', 'bhajan', 'arti', 'aarti', 'bhakthi',
    'comedy', 'short film', 'web series', 'episode',
  ];

  if (NON_MUSIC_MARKERS.some(m => titleLc.includes(m))) return false;

  // Reject obvious "official trailer" patterns even without the exact word
  if (/\btrailer\b/i.test(item.title)) return false;

  return true;
}

// ─── API call: videos.list (chart=mostPopular) ────────────────────────────────

/**
 * Fetch the most popular music videos from YouTube.
 * @param {string} apiKey
 * @param {string} [regionCode] - ISO 3166-1 alpha-2 (e.g. 'IN', 'US'). Omit for global.
 * @returns {Promise<Array>} Array of normalised video items
 */
async function fetchTrendingMusicVideos(apiKey, regionCode) {
  const params = {
    part:              'snippet,contentDetails,statistics',
    chart:             'mostPopular',
    videoCategoryId:   MUSIC_CATEGORY_ID,
    maxResults:        MAX_RESULTS_PER_QUERY,
    key:               apiKey,
  };

  if (regionCode) params.regionCode = regionCode;

  const label = regionCode ? `region=${regionCode}` : 'global';

  try {
    console.log(`[YTDiscovery] Fetching trending music videos (${label})`);
    const response = await axios.get(`${YT_BASE}/videos`, {
      params,
      timeout: 15000,
    });

    const items = (response.data.items || [])
      .map(normalizeYouTubeItem)
      .filter(isValidMusicVideo);

    console.log(`[YTDiscovery] Trending (${label}): ${items.length} valid items (raw: ${(response.data.items || []).length})`);
    return items;
  } catch (err) {
    const status = err.response && err.response.status;
    console.error(`[YTDiscovery] Failed to fetch trending (${label}): HTTP ${status || '?'} — ${err.message}`);
    return [];
  }
}

// ─── API call: search.list (regional/language queries) ───────────────────────

/**
 * Search YouTube for recent music videos matching a language query.
 * @param {string} apiKey
 * @param {string} query   - e.g. "new malayalam movie songs 2026"
 * @param {string} section - human label for logging
 * @returns {Promise<Array>} Array of normalised video items
 */
async function searchMusicVideos(apiKey, query, section) {
  // Step 1: search.list (returns basic snippet but NOT contentDetails/statistics)
  let videoIds;
  try {
    console.log(`[YTDiscovery] search.list query="${query}" section="${section}"`);
    const searchRes = await axios.get(`${YT_BASE}/search`, {
      params: {
        part:            'snippet',
        type:            'video',
        videoCategoryId: MUSIC_CATEGORY_ID,
        order:           'relevance',
        q:               query,
        maxResults:      MAX_RESULTS_PER_QUERY,
        key:             apiKey,
      },
      timeout: 15000,
    });

    videoIds = (searchRes.data.items || [])
      .map(item => item.id && item.id.videoId)
      .filter(Boolean);

    console.log(`[YTDiscovery] search.list returned ${videoIds.length} video IDs for "${section}"`);
  } catch (err) {
    const status = err.response && err.response.status;
    console.error(`[YTDiscovery] search.list failed for "${section}": HTTP ${status || '?'} — ${err.message}`);
    return [];
  }

  if (!videoIds.length) return [];

  // Step 2: videos.list to get contentDetails (duration) + statistics (viewCount)
  // YouTube's videos.list accepts comma-separated IDs, up to 50 at once.
  try {
    const detailRes = await axios.get(`${YT_BASE}/videos`, {
      params: {
        part: 'snippet,contentDetails,statistics',
        id:   videoIds.join(','),
        key:  apiKey,
      },
      timeout: 15000,
    });

    const items = (detailRes.data.items || [])
      .map(normalizeYouTubeItem)
      .filter(isValidMusicVideo);

    console.log(`[YTDiscovery] section "${section}": ${items.length} valid items after detail fetch + filter`);
    return items;
  } catch (err) {
    const status = err.response && err.response.status;
    console.error(`[YTDiscovery] videos.list detail fetch failed for "${section}": HTTP ${status || '?'} — ${err.message}`);
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all discovery candidates from YouTube.
 * Returns an object keyed by sectionType.
 *
 * @param {string} apiKey - YOUTUBE_API_KEY (server-side only, never exposed)
 * @returns {Promise<{
 *   trending: Array,
 *   malayalam: Array,
 *   tamil: Array,
 *   hindi: Array,
 * }>}
 */
async function fetchAllDiscoveryCandidates(apiKey) {
  if (!apiKey) {
    console.warn('[YTDiscovery] YOUTUBE_API_KEY is not set — skipping discovery fetch');
    return { trending: [], malayalam: [], tamil: [], hindi: [] };
  }

  const result = { trending: [], malayalam: [], tamil: [], hindi: [] };

  // ── Trending: India + global (cheap — 1 quota unit each) ─────────────────
  const [indiaTrending, globalTrending] = await Promise.all([
    fetchTrendingMusicVideos(apiKey, 'IN'),
    fetchTrendingMusicVideos(apiKey),
  ]);

  // Merge trending: India first (more relevant for South Asian content), then global
  // Deduplicate by videoId
  const trendingMap = new Map();
  for (const item of [...indiaTrending, ...globalTrending]) {
    if (!trendingMap.has(item.videoId)) {
      trendingMap.set(item.videoId, item);
    }
  }
  result.trending = Array.from(trendingMap.values());

  // ── Regional language queries (100 quota units each) ─────────────────────
  // Run sequentially to avoid rate limit issues on slower connections
  for (const { lang, query, section } of REGIONAL_QUERIES) {
    const items = await searchMusicVideos(apiKey, query, section);
    result[section] = items;
    // Small delay between search.list calls to be polite to the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(
    `[YTDiscovery] fetchAllDiscoveryCandidates complete: ` +
    `trending=${result.trending.length}, ` +
    `malayalam=${result.malayalam.length}, ` +
    `tamil=${result.tamil.length}, ` +
    `hindi=${result.hindi.length}`
  );

  return result;
}

module.exports = {
  fetchAllDiscoveryCandidates,
  fetchTrendingMusicVideos,
  searchMusicVideos,
  normalizeYouTubeItem,
  isValidMusicVideo,
  iso8601DurationToSeconds,
};
