// Minimal in-page test runner. run.py loads this after the app's own script and reads the
// "RF-TEST" lines it logs to the console.
window.RF_TESTS = [];

function test(name, fn, opts = {}) {
  RF_TESTS.push({ name, fn, ...opts });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, what, timeout = 20000) {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function runTests() {
  await sleep(1000);
  let passed = 0, failed = 0, skipped = 0;
  for (const t of RF_TESTS) {
    if (t.network && !window.RF_TEST_NETWORK) {
      console.log(`RF-TEST SKIP ${t.name} (needs network; run with --network)`);
      skipped++;
      continue;
    }
    try {
      await t.fn();
      console.log(`RF-TEST PASS ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`RF-TEST FAIL ${t.name} :: ${e.message}`);
      failed++;
    }
  }
  console.log(`RF-TEST DONE ${passed} passed, ${failed} failed, ${skipped} skipped`);
}

window.addEventListener('load', runTests);
