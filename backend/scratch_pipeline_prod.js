const axios = require('axios');

async function validatePipeline(url, sectionName) {
  console.log(`\n--- PIPELINE VALIDATION: ${sectionName} ---`);
  try {
    const response = await axios.get(url);
    let songs = [];
    if (response.data && response.data.data) {
        songs = response.data.data;
    } else if (response.data && response.data.results) {
        songs = response.data.results;
    } else if (Array.isArray(response.data)) {
        songs = response.data;
    }
    
    console.log(`API response count: ${songs.length}`);
    if (songs.length === 0) return;
    
    // Duration filter & language filter
    let durationFiltered = songs.filter(s => {
      const duration = Number(s.duration) || 0;
      return duration >= 90;
    });
    console.log(`Duration filter (>=90) count: ${durationFiltered.length}`);
    
    // Deduplication (simple mock based on ID)
    let seen = new Set();
    let unique = durationFiltered.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    console.log(`Deduplication count: ${unique.length}`);
    
    // Frontend limit
    let sliced = unique.slice(0, 25);
    console.log(`Frontend limit (25) count: ${sliced.length}`);
    
    // filterBadCovers mock
    let tokens = [
      'placeholder', 'default', 'banner', 'cover_all', 'playlist', 'thumb', 'thumbnail', 'small', '150x', '200x', 'logo', 'splash', '50x50', '150x150', 'unknown', 'compilation', 'various', 'mixtape', 'album_art', 'cover_generic', 'no_image', 'noimage', 'missing', 'temp', 'temporary', '100x100', '120x120', 'icon', 'avatar', 'profile'
    ];
    
    let badCoversCount = 0;
    
    let filterBadCoversList = sliced.filter(song => {
      let highestQuality = null;
      if (Array.isArray(song.image)) {
         let sorted = [...song.image].sort((a,b) => {
           let valA = a.quality ? parseInt(a.quality.split('x')[0]) : 0;
           let valB = b.quality ? parseInt(b.quality.split('x')[0]) : 0;
           return valB - valA;
         });
         highestQuality = sorted[0].link;
      } else if (typeof song.image === 'string') {
         highestQuality = song.image;
      }
      
      if (!highestQuality) { badCoversCount++; return false; }
      let s = highestQuality.toLowerCase();
      if (tokens.some(t => s.includes(t))) { badCoversCount++; return false; }
      if (s.length < 20) { badCoversCount++; return false; }
      if (s.match(/\b(50|100|120|150|200)x\1\b/)) { badCoversCount++; return false; }
      
      return true;
    });
    console.log(`filterBadCovers count: ${filterBadCoversList.length} (Dropped: ${badCoversCount})`);
    
  } catch (e) {
    console.error(`Error for ${sectionName}:`, e.message);
  }
}

async function run() {
  await validatePipeline('https://audionova-production-3ca3.up.railway.app/api/jiosaavn/fresh-songs/malayalam?limit=40', 'Malayalam Hits (Fresh)');
  await validatePipeline('https://audionova-production-3ca3.up.railway.app/api/jiosaavn/search/songs?query=malayalam%20romantic%20love%20songs&limit=30', 'Malayalam Romance');
  await validatePipeline('https://audionova-production-3ca3.up.railway.app/api/home/trending-enhanced', 'Trending Enhanced');
}

run();
