// Bump the app's version before pushing a change to what the site serves (the app or its data): today's date, then
// a count for the day (2026.11.04.1, .2, ...). Writes version.json, which the app checks to offer an update, and
// APP_VERSION in js/config.js, the version the running app says it is (shown on the About page).
// Usage (from the repo root): node tools/bump_version.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const now = new Date(), pad = n => String(n).padStart(2, '0');
const today = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
const was = JSON.parse(readFileSync('version.json', 'utf8')).version;
const version = was.startsWith(today + '.') ? `${today}.${+was.split('.').pop() + 1}` : `${today}.1`;
writeFileSync('version.json', `{ "version": "${version}" }\n`);
const config = readFileSync('js/config.js', 'utf8');
writeFileSync('js/config.js', config.replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${version}';`));
console.log(version);
