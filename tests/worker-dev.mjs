// Runs the accounts API (worker/) locally with wrangler dev, for the tests, on a new empty database each time (in a
// temp folder, so a database left from an older schema can't get in the way). TEST_LOGIN lets "test:<id>" sign in as
// a made-up account; it's only ever set here, never on the real API.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../worker/', import.meta.url));

export async function startWorker() {
  const port = 8800 + Math.floor(Math.random() * 100), url = `http://127.0.0.1:${port}`;
  const state = mkdtempSync(join(tmpdir(), 'rf-api-'));
  execSync(`npx --yes wrangler@4 d1 execute ride-finder --local --persist-to "${state}" --file schema.sql`, { cwd: WORKER, stdio: 'ignore', shell: true });
  const dev = spawn(`npx --yes wrangler@4 dev --port ${port} --ip 127.0.0.1 --persist-to "${state}" --var TEST_LOGIN:1`, { cwd: WORKER, shell: true, stdio: 'ignore' });
  const stop = () => {
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* gone */ } }
    else dev.kill();
    setTimeout(() => { try { rmSync(state, { recursive: true, force: true }); } catch (e) { /* still locked */ } }, 500);
  };
  for (let i = 0; i < 120; i++) {
    try { await fetch(url + '/links/nothing'); return { url, stop }; } catch (e) { await new Promise(r => setTimeout(r, 500)); }
  }
  stop();
  throw new Error('wrangler dev never started');
}
