/**
 * YoutubeDiscoveryCache.js
 *
 * MongoDB model for the YouTube-powered Home discovery cache.
 *
 * Each document holds the pre-validated JioSaavn song candidates
 * discovered via YouTube for a specific section type (trending,
 * malayalam, tamil, hindi, new_releases, etc.).
 *
 * Architecture:
 *   - Background job (every 6 hours) calls YouTube API, matches to JioSaavn,
 *     and upserts these documents.
 *   - /api/home/trending-enhanced reads from here, merges with JioSaavn live data,
 *     and returns the enriched list.
 *   - TTL index (expiresAt) lets MongoDB auto-expire stale documents if the
 *     refresh job stops running.
 *
 * NOTE: No existing models were modified. This is a new, standalone collection.
 */

'use strict';

const mongoose = require('mongoose');

// ─── Sub-schema: a single discovered + validated JioSaavn song ────────────────

const DiscoveredSongSchema = new mongoose.Schema({
  // Core JioSaavn fields (same shape as jiosaavn-proxy normalizeSong output)
  jiosaavnId:     { type: String, required: true },
  name:           { type: String, required: true },
  primaryArtists: { type: String, default: '' },
  language:       { type: String, default: '' },
  year:           { type: String, default: '' },
  releaseDate:    { type: String, default: '' },
  album: {
    id:  { type: String, default: '' },
    name: { type: String, default: '' },
    url:  { type: String, default: '' },
  },
  image: [{
    quality: String,
    link:    String,
  }],
  downloadUrl: [{
    quality: String,
    link:    String,
  }],
  playCount:   { type: Number, default: 0 },
  duration:    { type: Number, default: 0 },
  hasLyrics:   { type: Boolean, default: false },
  explicitContent: { type: Boolean, default: false },
  url:         { type: String, default: '' }, // JioSaavn perma_url

  // Discovery-specific metadata
  confidence:          { type: Number, required: true }, // match confidence [0..1]
  youtubeViewCount:    { type: Number, default: 0 },     // YouTube view count
  youtubeVideoId:      { type: String, default: '' },     // YouTube video ID (reference only)
  youtubePublishedAt:  { type: Date,   default: null },   // YouTube upload date
  youtubeTitle:        { type: String, default: '' },     // original YouTube title (for debug)
  youtubeChannel:      { type: String, default: '' },     // original YouTube channel (for debug)
  queryTier:           { type: Number, default: 0 },      // which JioSaavn search tier matched
  discoveryScore:      { type: Number, default: 0 },      // composite ranking score
  discoveredAt:        { type: Date, default: Date.now }, // when this candidate was stored
}, { _id: false });

// ─── Main cache document schema ───────────────────────────────────────────────

const YoutubeDiscoveryCacheSchema = new mongoose.Schema({
  /**
   * Which Home section this cache document covers.
   * One document per sectionType. Upserted on each refresh.
   */
  sectionType: {
    type: String,
    required: true,
    enum: ['trending', 'new_releases', 'malayalam', 'tamil', 'hindi', 'english'],
    unique: true,
  },

  songs: {
    type:    [DiscoveredSongSchema],
    default: [],
  },

  // Refresh metadata
  refreshedAt: { type: Date, default: null },
  totalYoutubeItems:    { type: Number, default: 0 }, // raw items fetched from YouTube
  totalMatched:         { type: Number, default: 0 }, // items matched to JioSaavn
  totalRejected:        { type: Number, default: 0 }, // items rejected (blacklist / confidence)
  totalDuplicates:      { type: Number, default: 0 }, // items removed as duplicates
  refreshDurationMs:    { type: Number, default: 0 }, // how long the refresh took

  /**
   * TTL field. MongoDB auto-deletes this document after expiresAt.
   * Set to refreshedAt + 8 hours. If refresh job stops, stale docs auto-expire.
   * The /api/home route falls back to JioSaavn-only data if no valid cache exists.
   */
  expiresAt: {
    type:    Date,
    default: () => new Date(Date.now() + 8 * 60 * 60 * 1000),
  },
}, {
  timestamps: true, // createdAt, updatedAt
});

// ─── Indexes ──────────────────────────────────────────────────────────────────

// TTL index: MongoDB auto-expires document when expiresAt is reached
YoutubeDiscoveryCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// sectionType is already unique (defined above), so MongoDB creates an index.
// Add a compound index for refresh-time queries.
YoutubeDiscoveryCacheSchema.index({ sectionType: 1, refreshedAt: -1 });

// ─── Model ────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('YoutubeDiscoveryCache', YoutubeDiscoveryCacheSchema);
