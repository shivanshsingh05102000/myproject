// server/models/Document.js
const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema(
  {
    pdfId: { type: String, required: true },               // original PDF id
    pageIndex: { type: Number, required: true },           // which page was signed

    pdfPathOriginal: { type: String, required: true },     // "/storage/original.pdf"
    pdfPathSigned: { type: String, required: true },       // "/storage/signed.pdf"

    beforeHash: { type: String, required: true },          // sha256 of original bytes
    afterHash: { type: String, required: true },           // sha256 of signed bytes

    signatureMeta: { type: Object, default: {} }           // mime, timestamp, user etc.
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Document ||
  mongoose.model('Document', DocumentSchema);
