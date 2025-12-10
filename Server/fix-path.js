// server/fix-paths.js
require('dotenv').config();
const mongoose = require('mongoose');
const Document = require('./models/Document');

async function run() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in .env — aborting');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, {});

  const docs = await Document.find({
    $or: [
      { pdfPathOriginal: { $regex: '^[A-Za-z]:\\\\' } },
      { pdfPathSigned: { $regex: '^[A-Za-z]:\\\\' } }
    ]
  }).exec();

  console.log('Found', docs.length, 'documents to fix');

  for (const d of docs) {
    const origFs = d.pdfPathOriginal || '';
    const signedFs = d.pdfPathSigned || '';
    const origName = origFs.split(/[\\/]/).pop();
    const signedName = signedFs.split(/[\\/]/).pop();
    if (origName) d.pdfPathOriginal = '/storage/' + origName;
    if (signedName) d.pdfPathSigned = '/storage/' + signedName;
    await d.save();
    console.log('Fixed', d._id.toString(), '->', d.pdfPathOriginal, d.pdfPathSigned);
  }

  console.log('Done. Updated', docs.length, 'documents.');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Script failed', err);
  process.exit(1);
});
