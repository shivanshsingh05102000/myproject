// server/controllers/signController.js
const fs = require('fs').promises;
const path = require('path');
const DocumentModel = require('../models/Document'); // may be undefined if not installed/configured
const { PDFDocument } = require('pdf-lib');
const { sha256Hex } = require('../utils/hash');

const BLOCKING_DB_SAVE = process.env.BLOCKING_DB_SAVE === 'true';

async function signPdfHandler(req, res) {
  try {
    const { pdfId, pageIndex, pdfBox, signatureBase64 } = req.body;
    if (!pdfId || pageIndex === undefined || !pdfBox || !signatureBase64) {
      return res.status(400).json({ error: 'Missing one of: pdfId, pageIndex, pdfBox, signatureBase64' });
    }

    const pdfPath = path.join(__dirname, '..', 'storage', `${pdfId}.pdf`);
    // read original PDF
    const pdfBytes = await fs.readFile(pdfPath);
    const beforeHash = sha256Hex(pdfBytes);

    // load PDF
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // prepare image bytes
    const base64part = signatureBase64.includes(',') ? signatureBase64.split(',')[1] : signatureBase64;
    const imgBytes = Buffer.from(base64part, 'base64');

    // embed image (png/jpg detection)
    let image;
    if (signatureBase64.startsWith('data:image/png')) {
      image = await pdfDoc.embedPng(imgBytes);
    } else {
      image = await pdfDoc.embedJpg(imgBytes);
    }

    // pick page
    const page = pdfDoc.getPage(pageIndex);
    if (!page) return res.status(400).json({ error: 'Invalid pageIndex' });

    const { x, y, width: boxW, height: boxH } = pdfBox;

    // preserve aspect ratio, fit inside box
    const imgW = image.width;
    const imgH = image.height;
    const imgRatio = imgW / imgH;
    const boxRatio = boxW / boxH;
    let drawW, drawH;
    if (imgRatio > boxRatio) {
      drawW = boxW;
      drawH = boxW / imgRatio;
    } else {
      drawH = boxH;
      drawW = boxH * imgRatio;
    }

    const offsetX = x + (boxW - drawW) / 2;
    const offsetY = y + (boxH - drawH) / 2;

    page.drawImage(image, { x: offsetX, y: offsetY, width: drawW, height: drawH });

    const outBytes = await pdfDoc.save();
    const afterHash = sha256Hex(outBytes);

    const outName = `${pdfId}-signed-${Date.now()}.pdf`;
    const outPath = path.join(__dirname, '..', 'storage', outName);
    await fs.writeFile(outPath, outBytes);

    // Prepare doc record
    const docRecord = {
      pdfId,
      pageIndex,
      pdfPathOriginal: pdfPath,
      pdfPathSigned: outPath,
      beforeHash,
      afterHash,
      signatureMeta: {
        mime: signatureBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'
      }
    };

    // Save to MongoDB:
    // - default: best-effort (do not block response)
    // - if BLOCKING_DB_SAVE=true -> await and return DB errors (for debugging)
    if (DocumentModel) {
      if (BLOCKING_DB_SAVE) {
        try {
          const saved = await DocumentModel.create(docRecord);
          console.log('Saved audit record to MongoDB (blocking):', saved._id);
        } catch (dbErr) {
          console.error('DB save failed (blocking mode):', dbErr);
          return res.status(500).json({ error: 'DB save failed', detail: dbErr.message });
        }
      } else {
        // non-blocking: fire-and-forget
        (async () => {
          try {
            const saved = await DocumentModel.create(docRecord);
            console.log('Saved audit record to MongoDB (async):', saved._id);
          } catch (dbErr) {
            console.warn('Failed to save audit record to MongoDB (async):', dbErr && dbErr.message ? dbErr.message : dbErr);
          }
        })();
      }
    } else {
      console.warn('DocumentModel not found: skipping DB save');
    }

    return res.json({ success: true, url: `/storage/${outName}`, beforeHash, afterHash });
  } catch (err) {
    console.error('signPdf error', err);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { signPdfHandler };
