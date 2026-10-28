// Copies the web app into www/, the folder Capacitor puts inside the iPhone app.
// (GitHub Pages serves the project folder itself; www/ is only for the native build.)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const FILES = ['index.html', 'styles.css', 'app.js', 'account.js', 'manifest.webmanifest', 'version.json'];
const DIRS = ['fonts', 'icons', 'vendor'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(out, f));
for (const d of DIRS) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
console.log(`www/ ready: ${FILES.length} files, ${DIRS.join(', ')}/`);
