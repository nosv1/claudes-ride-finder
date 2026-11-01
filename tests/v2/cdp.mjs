// Drive headless Edge/Chrome over the DevTools protocol with real waiting (headless
// --virtual-time-budget races ahead of MapLibre's background workers). Used by the v2 browser
// tests and handy for screenshots:
//
//   node tests/v2/cdp.mjs http://127.0.0.1:8765/v2/ shot.png [--mobile] [--wait "<js expr>"]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ mobile = false, width = 1400, height = 900 } = {}) {
  const exe = CANDIDATES.find(p => existsSync(p));
  if (!exe) throw new Error('No Edge/Chrome found; set BROWSER.');
  const port = 9300 + Math.floor(Math.random() * 600), dir = mkdtempSync(join(tmpdir(), 'rf-cdp-'));
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--disable-extensions', '--no-first-run', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); }
    catch (e) { await sleep(150); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map(), logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  const page = {
    logs,
    async goto(url) { await send('Page.navigate', { url }); },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.error) throw new Error(`${r.error.message}: ${expression.slice(0, 80)}`);
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result.result.value;
    },
    async waitFor(expression, timeout = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await page.eval(expression)) return true; } catch (e) { /* page still loading */ }
        await sleep(250);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async screenshot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(r.result.data, 'base64'));
    },
    close() {
      ws.close();
      proc.kill();
      setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* still locked */ } }, 500);
    },
  };
  return page;
}

// CLI: screenshot a page once an expression is true.
if (process.argv[1] && process.argv[1].endsWith('cdp.mjs') && process.argv.length > 3) {
  const [url, out] = process.argv.slice(2);
  const mobile = process.argv.includes('--mobile');
  const wait = process.argv.includes('--wait') ? process.argv[process.argv.indexOf('--wait') + 1] : null;
  const evalExpr = process.argv.includes('--eval') ? process.argv[process.argv.indexOf('--eval') + 1] : null;
  const page = await launch({ mobile });
  try {
    await page.goto(url);
    if (wait) await page.waitFor(wait, 60000);
    else await sleep(8000);
    if (evalExpr) console.log(JSON.stringify(await page.eval(evalExpr)));
    await sleep(1500);
    await page.screenshot(out);
    page.logs.forEach(l => console.log('console:', l));
  } finally {
    page.close();
  }
}
