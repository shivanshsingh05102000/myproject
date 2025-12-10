// server/utils/hash.js
const crypto = require('crypto');

function sha256Hex(input) {
  // input: Buffer, Uint8Array, or string
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = { sha256Hex };
