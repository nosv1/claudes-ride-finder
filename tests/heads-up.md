# Heads-ups

Not failures and not warnings: things to keep an eye on. When one fires, the test still passes, says so in its
output, and adds a line under **Fired** below, so `git status` shows this file changed. Look into it, then commit
the line with what you found (even if that's "fine, the roads changed").

| Heads-up | Fires when | Why keep an eye on it |
| --- | --- | --- |
| Router requests | A 3 h Generate from the test start sends more than 80 requests to the routers (the generator test in `tests/app/browser.test.mjs`, with `RF_NETWORK=1`) | Each request is a credit on Stadia Maps' free plan (200,000 a month) and load on the free public server. It sent 87 before 2026-11-20 and 69 after (FEATURES.md, Fewer requests). Roads and the router's map change, so a few more can be fine; a jump means a change to the generator is asking for more. |

## Fired

