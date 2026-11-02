const fs = require('node:fs');
const path = require('node:path');

const filename = process.env.EGGS_FILE || path.resolve(__dirname, '../../eggs/index.json');
module.exports = JSON.parse(fs.readFileSync(filename, 'utf8'));
