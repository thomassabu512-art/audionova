require('dotenv').config({ path: __dirname + '/.env' });
const mongoose = require('mongoose');

async function validate() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const cacheCollection = db.collection('youtube_discovery_cache');
  
  const records = await cacheCollection.find({}).toArray();
  console.log(`Found ${records.length} records.`);
  
  for (const record of records) {
    console.log(`Section: ${record.sectionType}, Songs: ${record.songs ? record.songs.length : 0}`);
    if (record.songs && record.songs.length > 0) {
      console.log(`First song downloadUrl:`, JSON.stringify(record.songs[0].downloadUrl));
    }
  }
  
  process.exit(0);
}
validate().catch(console.error);
