// Heads-ups: not failures and not warnings, just something to keep an eye on (tests/heads-up.md lists them). One that
// fires is printed in the test's output and added to the bottom of tests/heads-up.md, so `git status` shows it.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pad = n => String(n).padStart(2, '0');

// t: the test it fires in (node:test's context), for the output; text: what happened, with the number.
export function headsUp(t, text) {
  const now = new Date(), version = JSON.parse(readFileSync(`${ROOT}version.json`, 'utf8')).version;
  const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  t.diagnostic(`heads-up: ${text} (added to tests/heads-up.md)`);
  appendFileSync(`${ROOT}tests/heads-up.md`, `- ${when} (local), version ${version}: ${text}\n`);
}
