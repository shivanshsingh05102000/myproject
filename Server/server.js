// server/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const crypto = require('crypto');
const cors = require('cors');
const { PDFDocument } = require('pdf-lib');

const UploadedDocument = require('./models/UploadedDocument');
const DocumentModel = require('./models/Document');
const { sha256Hex } = require('./utils/hash');


const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

const STORAGE_DIR = path.join(__dirname, 'storage');
fs.mkdir(STORAGE_DIR, { recursive: true }).catch(() => {});

app.use('/storage', express.static(STORAGE_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const base = (file.originalname || 'upload').replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
    const name = `${base.replace(/\.pdf$/i, '')}-${Date.now()}.pdf`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF allowed'), false);
    cb(null, true);
  },
});

async function computeFileSha256Hex(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// POST /api/check-pdf
app.post('/api/check-pdf', async (req, res) => {
  try {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'hash missing' });
    const found = await UploadedDocument.findOne({ pdfHash: hash }).lean();
    if (!found) return res.json({ exists: false });
    return res.json({ exists: true, url: found.pdfPath, doc: found });
  } catch (err) {
    console.error('check-pdf error', err);
    return res.status(500).json({ error: err.message || 'check failed' });
  }
});

// POST /api/upload-pdf
app.post('/api/upload-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.filename;
    const pdfId = filename.replace(/\.pdf$/i, '');
    const publicPath = `/storage/${filename}`;

    let pdfHash = req.body?.pdfHash;
    if (!pdfHash) {
      try { pdfHash = await computeFileSha256Hex(path.join(STORAGE_DIR, filename)); } catch (e) { console.warn('Failed compute hash', e); }
    }

    if (pdfHash) {
      const existing = await UploadedDocument.findOne({ pdfHash }).lean();
      if (existing) {
        try { await fs.unlink(path.join(STORAGE_DIR, filename)); } catch (e) { console.warn('failed to delete duplicate', e); }
        return res.json({ success: true, exists: true, url: existing.pdfPath, pdfId: existing.pdfId, doc: existing });
      }
    }

    const created = await UploadedDocument.create({
      pdfId,
      pdfPath: publicPath,
      pdfHash: pdfHash || null,
      originalFilename: req.file.originalname,
      size: req.file.size,
    });

    return res.json({ success: true, exists: false, pdfId, url: publicPath, doc: created });
  } catch (err) {
    console.error('upload-pdf err', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// POST /api/sign-pdf
app.post('/api/sign-pdf', async (req, res) => {
  try {
    const { pdfId, pageIndex, pdfBox, signatureBase64 } = req.body;
    if (!pdfId || pageIndex === undefined || !pdfBox || !signatureBase64) return res.status(400).json({ error: 'missing' });

    const origPath = path.join(STORAGE_DIR, `${pdfId}.pdf`);
    const origExists = await fs.stat(origPath).then(() => true).catch(() => false);
    if (!origExists) return res.status(400).json({ error: `original PDF not found: ${origPath}` });

    const bytes = await fs.readFile(origPath);
    const beforeHash = sha256Hex(bytes);

    const pdfDoc = await PDFDocument.load(bytes);
    const imgData = (signatureBase64 || '').includes(',') ? signatureBase64.split(',')[1] : signatureBase64;
    const imgBytes = Buffer.from(imgData, 'base64');

    let image;
    if ((signatureBase64 || '').startsWith('data:image/png')) image = await pdfDoc.embedPng(imgBytes);
    else image = await pdfDoc.embedJpg(imgBytes);

    const page = pdfDoc.getPage(pageIndex);
    const { x, y, width: boxW, height: boxH } = pdfBox;

    const imgW = image.width, imgH = image.height, imgRatio = imgW / imgH, boxRatio = boxW / boxH;
    let drawW, drawH;
    if (imgRatio > boxRatio) { drawW = boxW; drawH = boxW / imgRatio; } else { drawH = boxH; drawW = boxH * imgRatio; }
    const offsetX = x + (boxW - drawW) / 2;
    const offsetY = y + (boxH - drawH) / 2;

    page.drawImage(image, { x: offsetX, y: offsetY, width: drawW, height: drawH });

    const outBytes = await pdfDoc.save();
    const afterHash = sha256Hex(outBytes);

    const outName = `${pdfId}-signed-${Date.now()}.pdf`;
    const outPath = path.join(STORAGE_DIR, outName);
    await fs.writeFile(outPath, outBytes);

    const docRecord = {
      pdfId,
      pageIndex,
      pdfPathOriginal: `/storage/${path.basename(origPath)}`,
      pdfPathSigned: `/storage/${path.basename(outPath)}`,
      beforeHash,
      afterHash,
      signatureMeta: { mime: (signatureBase64 || '').startsWith('data:image/png') ? 'image/png' : 'image/jpeg' },
    };

    if (DocumentModel) {
      DocumentModel.create(docRecord).then((s) => console.log('Saved audit record to MongoDB', s._id)).catch((e) => console.error('DB save failed (async):', e.message || e));
    }

    return res.json({ success: true, url: `/storage/${path.basename(outPath)}`, beforeHash, afterHash });
  } catch (err) {
    console.error('sign error', err);
    return res.status(500).json({ error: err.message || 'Sign failed' });
  }
});

// POST /api/sign-pdf-multi
app.post('/api/sign-pdf-multi', async (req, res) => {
  try {
    const { pdfId, items, signatureBase64 } = req.body;
    if (!pdfId || !Array.isArray(items) || items.length === 0 || !signatureBase64) return res.status(400).json({ error: 'missing' });

    const origPath = path.join(STORAGE_DIR, `${pdfId}.pdf`);
    const origExists = await fs.stat(origPath).then(() => true).catch(() => false);
    if (!origExists) return res.status(400).json({ error: `original PDF not found: ${origPath}` });

    const bytes = await fs.readFile(origPath);
    const beforeHash = sha256Hex(bytes);

    const pdfDoc = await PDFDocument.load(bytes);
    const imgData = (signatureBase64 || '').includes(',') ? signatureBase64.split(',')[1] : signatureBase64;
    const imgBytes = Buffer.from(imgData, 'base64');

    let image;
    if ((signatureBase64 || '').startsWith('data:image/png')) image = await pdfDoc.embedPng(imgBytes);
    else image = await pdfDoc.embedJpg(imgBytes);

    for (const it of items) {
      const { pageIndex, pdfBox } = it;
      const page = pdfDoc.getPage(pageIndex);
      if (!page) {
        console.warn('Missing page for index', pageIndex);
        continue;
      }
      const { x, y, width: boxW, height: boxH } = pdfBox;
      const imgW = image.width, imgH = image.height, imgRatio = imgW / imgH, boxRatio = boxW / boxH;
      let drawW, drawH;
      if (imgRatio > boxRatio) { drawW = boxW; drawH = boxW / imgRatio; } else { drawH = boxH; drawW = boxH * imgRatio; }
      const offsetX = x + (boxW - drawW) / 2;
      const offsetY = y + (boxH - drawH) / 2;
      page.drawImage(image, { x: offsetX, y: offsetY, width: drawW, height: drawH });
    }

    const outBytes = await pdfDoc.save();
    const afterHash = sha256Hex(outBytes);

    const outName = `${pdfId}-signed-multi-${Date.now()}.pdf`;
    const outPath = path.join(STORAGE_DIR, outName);
    await fs.writeFile(outPath, outBytes);

    const baseOriginalPublic = `/storage/${path.basename(origPath)}`;
    const baseSignedPublic = `/storage/${path.basename(outPath)}`;
    const docsToCreate = items.map((it) => ({
      pdfId,
      pageIndex: it.pageIndex,
      pdfPathOriginal: baseOriginalPublic,
      pdfPathSigned: baseSignedPublic,
      beforeHash,
      afterHash,
      signatureMeta: { mime: (signatureBase64 || '').startsWith('data:image/png') ? 'image/png' : 'image/jpeg' },
    }));

    if (DocumentModel) {
      DocumentModel.insertMany(docsToCreate).then((s) => console.log('Inserted audit records:', s.length)).catch((e) => console.error('Failed to insert audit records:', e.message || e));
    }

    return res.json({ success: true, url: baseSignedPublic, beforeHash, afterHash });
  } catch (err) {
    console.error('sign-pdf-multi error', err);
    return res.status(500).json({ error: err.message || 'Sign multi failed' });
  }
});

// GET /api/documents
app.get('/api/documents', async (req, res) => {
  try {
    const docs = await DocumentModel.find().sort({ createdAt: -1 }).lean();
    return res.json({ value: docs, Count: docs.length });
  } catch (err) {
    console.error('list docs err', err);
    return res.status(500).json({ error: err.message || 'list failed' });
  }
});

// Mongoose connect
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.warn('MONGO_URI not set — DB will not connect. Upload records and audits will fail.');
} else {
  mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch((err) => console.warn('MongoDB connection error:', err.message || err));
}

// Start
// use the provided PORT (Render) or fallback
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

