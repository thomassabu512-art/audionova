/**
 * discoveryMatcher.js
 *
 * Wrapper that drives the existing importMatcherService for the
 * Home discovery use case.
 *
 * IMPORTANT:
 *  - importMatcherService.js is NOT modified — this wrapper calls it.
 *  - sessionStore.js is NOT used (discovery doesn't need import sessions).
 *  - The existing playlist-import flow is completely unaffected.
 *
 * Differences vs. playlist import mode:
 *  - Uses a configurable minimum confidence threshold (DISCOVERY_MIN_CONFIDENCE).
 *  - skipKaraoke is always true.
 *  - strictMode is false (uses DISCOVERY_MIN_CONFIDENCE instead of STRICT_THRESHOLD).
 *  - Duplicate resolution: keeps highest-confidence candidate per JioSaavn song ID.
 *  - Applies diversity rules: max songs per album, max songs per primary artist.
 *  - Applies devotional/religious filtering (shared keyword list).
 *  - Attaches YouTube-side metadata (viewCount, publishedAt, etc.) to each result.
 *
 * This service does NOT import or call sessionStore — it returns results directly.
 */

'use strict';

const {
  processWithConcurrency: _processWithConcurrency,
  MATCH_THRESHOLD,
  STRICT_THRESHOLD,
  CONCURRENCY,
} = require('./importMatcherService');
const { isBlacklisted } = require('../utils/blacklistFilter');

// ─── Config (env vars with safe defaults) ────────────────────────────────────

const DISCOVERY_MIN_CONFIDENCE = parseFloat(
  process.env.DISCOVERY_MIN_CONFIDENCE || '0.65'
);
const DISCOVERY_MAX_PER_ALBUM = parseInt(
  process.env.DISCOVERY_MAX_PER_ALBUM || '2', 10
);
const DISCOVERY_MAX_PER_ARTIST = parseInt(
  process.env.DISCOVERY_MAX_PER_ARTIST || '3', 10
);

console.log(
  `[DiscoveryMatcher] Config: minConfidence=${DISCOVERY_MIN_CONFIDENCE}` +
  ` maxPerAlbum=${DISCOVERY_MAX_PER_ALBUM}` +
  ` maxPerArtist=${DISCOVERY_MAX_PER_ARTIST}`
);

// ─── Devotional / religious / caste keyword filter ────────────────────────────
// Mirror of recommendationService.ts DEVOTIONAL_KEYWORDS (kept in sync manually).
// Not importing from the frontend TS file — this is the backend copy.

const DEVOTIONAL_KEYWORDS = new Set([
  'bhakthi', 'bhakti', 'devotional', 'ayyappa', 'krishna', 'sivan', 'shiva',
  'vishnu', 'murugan', 'ganesha', 'ganpati', 'vinayagar', 'amman', 'devi',
  'bhajan', 'bhajans', 'stotram', 'stotra', 'shloka', 'sloka', 'kavacham',
  'suprabhatam', 'aarti', 'chalisa', 'mantra', 'chanting', 'prayer',
  'prarthana', 'namaz', 'qawwali', 'naat', 'islamic', 'nasheed', 'duas',
  'christian', 'gospel', 'carol', 'carols', 'church', 'praise', 'worship',
  'hymn', 'hymns', 'jesus', 'allah', 'bible', 'quran',
  'temple', 'mandir', 'masjid', 'ramzan', 'eid',
  'subhanallah', 'alhamdulillah', 'harivarasanam', 'sharanm', 'saranam',
  'guruvayoor', 'shabarimala', 'sabarimala',
  'mahadev', 'bholenath', 'bismillah', 'mappila pattu', 'mappilapattu',
  'caste', 'kavadi',
  'bhagwan', 'om namah', 'bhole', 'bholenath', 'trishul',
  'shankara', 'shankar', 'siva', 'rudra', 'tandav', 'tandava',
  'jai shree', 'jai sri', 'ayyappan', 'hanuman', 'ram', 'sita', 'radha',
  'govinda', 'vithal', 'vithoba', 'ganapati', 'saibaba', 'sai baba',
  'buddha', 'namo', 'namah', 'shambho', 'shambhu',
]);

const DEVOTIONAL_REGEXES = Array.from(DEVOTIONAL_KEYWORDS).map(
  kw => new RegExp(`\\b${kw}\\b`, 'i')
);

/**
 * Returns true if the JioSaavn song should be excluded as devotional/religious.
 * Checks song name, album name, and artist name.
 *
 * @param {object} song - JioSaavn song (from normalizeSong())
 * @returns {boolean}
 */
function isDevotionalSong(song) {
  if (!song) return false;
  const albumName = typeof song.album === 'string'
    ? song.album
    : (song.album && song.album.name) || '';
  const haystack = [song.name, albumName, song.primaryArtists, song.language]
    .filter(Boolean).join(' ');
    
  for (const regex of DEVOTIONAL_REGEXES) {
    if (regex.test(haystack)) return true;
  }
  return false;
}

// ─── Discovery-specific Audio Variant Blacklist ───────────────────────────────

const DISCOVERY_BLACKLIST_REGEXES = [
  /\b(karaoke)\b/i,
  /\b(instrumental)\b/i,
  /\b(8d)\b/i,
  /\b(lo-?fi)\b/i,
  /\b(tribute)\b/i,
  /\b(backing track)\b/i,
  /\b(slowed\s*\+?\s*reverb)\b/i,
  /\b(slowed)\b/i,
];

function isDiscoveryBlacklisted(song, ytTitle) {
  const haystack = `${song ? song.name : ''} ${ytTitle || ''}`;
  for (const regex of DISCOVERY_BLACKLIST_REGEXES) {
    if (regex.test(haystack)) return true;
  }
  return false;
}

// ─── Generic Title Protection (The "Mirza" Fix) ───────────────────────────────

/**
 * Prevent generic 1 or 2 word titles from matching if the artist is neutral or incorrect.
 * This fixes the "Mirza" false positive where Topic channels bypass artist validation.
 */
function isGenericTitleMismatch(match) {
  if (!match || !match.song || !match.song.name) return false;
  
  const cleanName = match.song.name.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const wordCount = cleanName.split(/\s+/).length;
  
  // Check if title is 1 or 2 words (generic/short)
  if (wordCount <= 2) {
    // If artist similarity is poor or neutral (<0.60)
    if (match.artistSim < 0.60) {
      const jioArtists = (match.song.primaryArtists || '').toLowerCase();
      const ytTitle = (match.ytTitle || '').toLowerCase();
      const ytChannel = (match.ytChannel || '').toLowerCase();
      
      if (!jioArtists) return true; // Can't verify, reject
      
      const artistsList = jioArtists.split(',').map(a => a.trim()).filter(a => a.length > 2);
      
      let foundArtist = false;
      for (const a of artistsList) {
        if (ytTitle.includes(a) || ytChannel.includes(a)) {
          foundArtist = true;
          break;
        }
      }
      
      if (!foundArtist) {
        return true; // Rejected due to missing artist confirmation
      }
    }
  }
  return false;
}

// ─── Duplicate resolution: keep highest-confidence per JioSaavn song ID ──────

/**
 * Given an array of matchItem results (type='matched'), deduplicate by
 * JioSaavn song ID keeping the HIGHEST confidence result for each ID.
 *
 * This is intentionally different from importMatcherService.deduplicateOutput()
 * which keeps the FIRST occurrence. For discovery we want best-confidence.
 *
 * @param {Array} matched
 * @returns {{ dedupedMatched: Array, duplicatesRemoved: number }}
 */
function deduplicateByBestConfidence(matched) {
  const best = new Map(); // songId → matchResult (highest confidence)

  for (const item of matched) {
    const songId = item.song && item.song.id;
    if (!songId) {
      best.set(Symbol(), item); // no ID: always include
      continue;
    }
    if (!best.has(songId) || item.confidence > best.get(songId).confidence) {
      best.set(songId, item);
    }
  }

  const dedupedMatched = Array.from(best.values());
  const duplicatesRemoved = matched.length - dedupedMatched.length;
  return { dedupedMatched, duplicatesRemoved };
}

// ─── Diversity enforcement ────────────────────────────────────────────────────

/**
 * Enforce max-per-album and max-per-artist diversity rules.
 * Returns a filtered subset of matched results.
 *
 * @param {Array} matched   - deduped matchItem results
 * @param {number} maxPerAlbum
 * @param {number} maxPerArtist
 * @returns {{ diverseMatched: Array, removedByDiversity: number }}
 */
function applyDiversityRules(matched, maxPerAlbum, maxPerArtist) {
  const albumCounts  = new Map();  // albumKey → count
  const artistCounts = new Map(); // artistKey → count
  const diverseMatched = [];

  for (const item of matched) {
    const song = item.song;
    if (!song) continue;

    // Album key: normalise to lowercase
    const rawAlbum = song.album && song.album.name ? song.album.name : '';
    const albumKey = rawAlbum.toLowerCase().trim();

    // Primary artist key: take first artist (before comma)
    const rawArtist = song.primaryArtists || '';
    const artistKey = rawArtist.split(/[,&]/)[0].toLowerCase().trim();

    const albumCount  = albumCounts.get(albumKey) || 0;
    const artistCount = artistCounts.get(artistKey) || 0;

    // Check diversity limits (empty albumKey / artistKey are exempt)
    if (albumKey && albumCount >= maxPerAlbum)   continue;
    if (artistKey && artistCount >= maxPerArtist) continue;

    if (albumKey)  albumCounts.set(albumKey, albumCount + 1);
    if (artistKey) artistCounts.set(artistKey, artistCount + 1);

    diverseMatched.push(item);
  }

  const removedByDiversity = matched.length - diverseMatched.length;
  return { diverseMatched, removedByDiversity };
}

// ─── Scoring: composite discovery score ─────────────────────────────────────

/**
 * Compute composite discovery score for ranking.
 *
 * Formula:
 *   discoveryScore =
 *     (confidence * 0.40)         — match quality
 *     + (viewCountNorm * 0.25)    — YouTube popularity
 *     + (recencyScore * 0.20)     — release recency
 *     + (playCountNorm * 0.15)    — JioSaavn own popularity
 *
 * All components are in [0..1].
 *
 * @param {object} matchResult - from matchItem() with attached ytMeta
 * @param {number} maxViewCount - highest viewCount in this batch (for normalization)
 * @param {number} maxPlayCount - highest playCount in this batch
 * @returns {number} score in [0..1]
 */
function computeDiscoveryScore(matchResult, maxViewCount, maxPlayCount) {
  const confidence = matchResult.confidence || 0;

  const viewCount    = (matchResult.ytMeta && matchResult.ytMeta.viewCount) || 0;
  const viewCountNorm = maxViewCount > 0
    ? Math.log1p(viewCount) / Math.log1p(maxViewCount)
    : 0;

  const playCount    = (matchResult.song && matchResult.song.playCount) || 0;
  const playCountNorm = maxPlayCount > 0
    ? Math.log1p(playCount) / Math.log1p(maxPlayCount)
    : 0;

  // Recency: boost current year, partial boost for last year
  let recencyScore = 0;
  const currentYear = new Date().getFullYear();
  const song = matchResult.song;
  const songYear = song
    ? (parseInt(song.year || '0', 10) || parseInt((song.releaseDate || '').substring(0, 4), 10) || 0)
    : 0;

  if (songYear === currentYear)        recencyScore = 1.0;
  else if (songYear === currentYear - 1) recencyScore = 0.7;
  else if (songYear === currentYear - 2) recencyScore = 0.3;

  return (
    confidence      * 0.40 +
    viewCountNorm   * 0.25 +
    recencyScore    * 0.20 +
    playCountNorm   * 0.15
  );
}

// ─── Main discovery matching function ────────────────────────────────────────

/**
 * Match an array of YouTube discovery items to JioSaavn songs.
 *
 * @param {Array<{
 *   videoId: string,
 *   title: string,
 *   channelTitle: string,
 *   publishedAt: Date|null,
 *   viewCount: number,
 *   durationSec: number,
 * }>} ytItems - from youtubeDiscoveryService
 *
 * @param {object} [options]
 * @param {number} [options.minConfidence] - override DISCOVERY_MIN_CONFIDENCE
 * @param {number} [options.maxPerAlbum]  - override DISCOVERY_MAX_PER_ALBUM
 * @param {number} [options.maxPerArtist] - override DISCOVERY_MAX_PER_ARTIST
 *
 * @returns {Promise<{
 *   songs: Array,           — validated JioSaavn songs enriched with discovery metadata
 *   stats: {
 *     totalInput: number,
 *     totalMatched: number,
 *     totalRejected: number,
 *     totalDuplicates: number,
 *     totalDiversity: number,
 *   },
 * }>}
 */
async function matchDiscoveryCandidates(ytItems, options) {
  options = options || {};

  const minConfidence = options.minConfidence || DISCOVERY_MIN_CONFIDENCE;
  const maxPerAlbum   = options.maxPerAlbum   || DISCOVERY_MAX_PER_ALBUM;
  const maxPerArtist  = options.maxPerArtist  || DISCOVERY_MAX_PER_ARTIST;

  if (!ytItems || ytItems.length === 0) {
    console.log('[DiscoveryMatcher] No YouTube items to process');
    return {
      songs: [],
      stats: { totalInput: 0, totalMatched: 0, totalRejected: 0, totalDuplicates: 0, totalDiversity: 0 },
    };
  }

  console.log(`[DiscoveryMatcher] Starting match: ${ytItems.length} YouTube items, minConfidence=${minConfidence}`);

  // Build ytItem map for later metadata attachment (videoId → ytItem)
  const ytMetaByVideoId = new Map();
  for (const item of ytItems) {
    if (item.videoId) ytMetaByVideoId.set(item.videoId, item);
  }

  // Convert to the format processWithConcurrency() expects
  // (same as { title, channelTitle, videoId, position } from playlist import)
  const inputItems = ytItems.map((item, i) => ({
    title:        item.title,
    channelTitle: item.channelTitle,
    videoId:      item.videoId || `discovery_${i}`,
    position:     i,
  }));

  // ── Call the existing matcher (no modification to importMatcherService) ──
  // options: skipKaraoke=true, strictMode=false (we use our own minConfidence),
  // threshold=minConfidence (importMatcherService will use this as the base threshold)
  const matchResult = await _processWithConcurrency(
    inputItems,
    /* onProgress */ null,
    {
      skipKaraoke: true,
      strictMode:  false,
      threshold:   minConfidence,
    }
  );

  const rawMatched   = matchResult.matched   || [];
  const rawUnmatched = matchResult.unmatched || [];

  console.log(
    `[DiscoveryMatcher] Raw results: matched=${rawMatched.length} unmatched=${rawUnmatched.length}`
  );

  // ── Filter 1: additional confidence check (belt-and-suspenders) ───────────
  // processWithConcurrency already applies threshold, but we double-check
  // because tiered thresholds may pass lower-confidence matches on Tier 0/1.
  const confFiltered = rawMatched.filter(m => m.confidence >= minConfidence);
  const rejectedConf = rawMatched.length - confFiltered.length;

  // ── Filter 2: devotional/religious exclusion ──────────────────────────────
  const secularMatched = confFiltered.filter(m => !isDevotionalSong(m.song));
  const rejectedDevotional = confFiltered.length - secularMatched.length;

  // ── Filter 3: JioSaavn title blacklist (redundant safety check) ──────────
  // scoreCandidate() already runs isBlacklisted(), but let's guard against
  // any future code path changes.
  const cleanMatched = secularMatched.filter(m =>
    m.song && m.song.name && !isBlacklisted(m.song.name)
  );
  let rejectedBlacklist = secularMatched.length - cleanMatched.length;

  // ── Filter 4: Generic Title Protection (The "Mirza" Fix) ──────────────────
  const verifiedMatched = cleanMatched.filter(m => !isGenericTitleMismatch(m));
  const rejectedGeneric = cleanMatched.length - verifiedMatched.length;

  // ── Filter 5: Discovery-Specific Audio Variant Blacklist ──────────────────
  const variantFiltered = verifiedMatched.filter(m => !isDiscoveryBlacklisted(m.song, m.ytTitle));
  const rejectedVariants = verifiedMatched.length - variantFiltered.length;

  rejectedBlacklist += rejectedVariants;

  const totalRejected = rawUnmatched.length + rejectedConf + rejectedDevotional + rejectedBlacklist + rejectedGeneric;

  // ── Deduplication: keep highest-confidence per song ID ────────────────────
  const { dedupedMatched, duplicatesRemoved } = deduplicateByBestConfidence(variantFiltered);

  // ── Diversity rules ───────────────────────────────────────────────────────
  const { diverseMatched, removedByDiversity } = applyDiversityRules(
    dedupedMatched, maxPerAlbum, maxPerArtist
  );

  // ── Scoring: compute discovery score and attach YouTube metadata ──────────
  const maxViewCount = Math.max(...diverseMatched.map(m => {
    const meta = ytMetaByVideoId.get(m.videoId);
    return (meta && meta.viewCount) || 0;
  }), 1);

  const maxPlayCount = Math.max(...diverseMatched.map(m =>
    (m.song && m.song.playCount) || 0
  ), 1);

  const backendOrigin = process.env.BACKEND_PUBLIC_URL || 'https://audionova-production-3ca3.up.railway.app';
  const rewriteUrl = (arr) => {
    if (!arr || !Array.isArray(arr)) return arr;
    return arr.map(item => {
      if (item.link && item.link.startsWith('/api/')) {
        return { ...item, link: backendOrigin + item.link };
      }
      return item;
    });
  };

  const scoredMatched = diverseMatched.map(m => {
    const ytMeta = ytMetaByVideoId.get(m.videoId) || null;

    // Attach YouTube metadata to the match result for storage
    const enriched = {
      ...m,
      ytMeta,
    };

    const discoveryScore = computeDiscoveryScore(enriched, maxViewCount, maxPlayCount);

    return {
      // Core JioSaavn song data
      jiosaavnId:    m.song.id,
      name:          m.song.name,
      primaryArtists: m.song.primaryArtists || '',
      language:      m.song.language || '',
      year:          m.song.year || '',
      releaseDate:   m.song.releaseDate || '',
      album:         m.song.album || { id: '', name: '', url: '' },
      image:         rewriteUrl(m.song.image) || [],
      downloadUrl:   rewriteUrl(m.song.downloadUrl) || [],
      playCount:     m.song.playCount || 0,
      duration:      m.song.duration || 0,
      hasLyrics:     m.song.hasLyrics || false,
      explicitContent: m.song.explicitContent || false,
      url:           m.song.url || '',
      // Discovery metadata
      confidence:          m.confidence,
      youtubeViewCount:    (ytMeta && ytMeta.viewCount)    || 0,
      youtubeVideoId:      (ytMeta && ytMeta.videoId)      || m.videoId || '',
      youtubePublishedAt:  (ytMeta && ytMeta.publishedAt)  || null,
      youtubeTitle:        (ytMeta && ytMeta.title)        || m.ytTitle || '',
      youtubeChannel:      (ytMeta && ytMeta.channelTitle) || m.ytChannel || '',
      queryTier:           m.queryTier || 0,
      discoveryScore:      parseFloat(discoveryScore.toFixed(4)),
      discoveredAt:        new Date(),
    };
  });

  // Sort by discoveryScore descending
  scoredMatched.sort((a, b) => b.discoveryScore - a.discoveryScore);

  const stats = {
    totalInput:     ytItems.length,
    totalMatched:   scoredMatched.length,
    totalRejected:  totalRejected,
    totalDuplicates: duplicatesRemoved,
    totalDiversity:  removedByDiversity,
  };

  console.log(
    `[DiscoveryMatcher] Done: matched=${stats.totalMatched}` +
    ` rejected=${stats.totalRejected}` +
    ` duplicates=${stats.totalDuplicates}` +
    ` diversity=${stats.totalDiversity}`
  );

  return { songs: scoredMatched, stats };
}

module.exports = {
  matchDiscoveryCandidates,
  isDevotionalSong,
  isGenericTitleMismatch,
  isDiscoveryBlacklisted,
  deduplicateByBestConfidence,
  applyDiversityRules,
  computeDiscoveryScore,
  DISCOVERY_MIN_CONFIDENCE,
  DISCOVERY_MAX_PER_ALBUM,
  DISCOVERY_MAX_PER_ARTIST,
};
