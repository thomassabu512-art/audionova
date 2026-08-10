const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
  
  const YoutubeDiscoveryCache = require('./models/YoutubeDiscoveryCache');
  
  const cache = await YoutubeDiscoveryCache.find({}).lean();
  
  for (const doc of cache) {
    console.log(`\nSection: ${doc.sectionType}`);
    console.log(`Songs cached: ${doc.songs.length}`);
    if (doc.songs.length > 0) {
      const sample = doc.songs[0];
      console.log(`Sample Song: ${sample.name} (${sample.language})`);
      console.log(`Download URL:`, sample.downloadUrl.slice(0, 1) || 'None');
      console.log(`Image URL:`, sample.image.slice(0, 1) || 'None');
    }
  }
  
  process.exit(0);
}

run().catch(console.error);
