#!/usr/bin/env node
/* Netlify build step: writes public/config.js from the BEYOND_API_URL environment variable.
   Fails the build if it is missing or invalid, so a frontend with no backend is never deployed by accident. */
const fs = require('fs'), path = require('path');
const raw = (process.env.BEYOND_API_URL || '').trim().replace(/\/+$/, '');
let ok = false;
try { const u = new URL(raw); ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)); } catch (e) { /* invalid */ }
if (!ok) {
  console.error('\nBEYOND_API_URL is missing or invalid.\nSet it in Netlify: Site configuration > Environment variables > BEYOND_API_URL = https://your-backend-host (https, no trailing path).\n');
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'window.BEYOND_CONFIG=' + JSON.stringify({ apiUrl: raw }) + ';\n');
console.log('Wrote public/config.js with apiUrl =', raw);
