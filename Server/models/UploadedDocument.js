// server/models/UploadedDocument.js
const mongoose = require('mongoose');

const UploadedDocumentSchema = new mongoose.Schema(
  {
    pdfId: { type: String, required: true, unique: true },   // filename without .pdf
    pdfPath: { type: String, required: true },               // "/storage/xxxx.pdf"
    pdfHash: { type: String, required: true, index: true },  // SHA-256 of file bytes
    originalFilename: { type: String },
    size: { type: Number }
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.UploadedDocument ||
  mongoose.model('UploadedDocument', UploadedDocumentSchema);
