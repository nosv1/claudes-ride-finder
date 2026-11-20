// Usage counts for the owner's usage page (usage/): how often things happen, never who. Counted here and sent as
// one small note to the accounts API when the app goes to the background (or closes), so a Generate's many routes
// cost one request, not one each. Nothing about the rider goes with it: just { event: how many }.
import { API_URL } from './config.js';
import { check } from './check.js';

// What's counted, and the most of each one note may carry: the API's caps (worker/src/index.js, USAGE_MAX). It refuses
// a note with anything else in it.
const MAX = { open: 1, generate: 50, ride: 20, 'route-fossgis': 1000, 'route-stadia': 1000, 'route-osrm': 1000, 'route-none': 1000 };

// Counts not sent yet: event → how many. One entry an event at most, each capped at its MAX.
const tally = new Map();

export function countUse(event) {
  if (!check(Object.hasOwn(MAX, event), `a usage event: ${event}`)) return;
  tally.set(event, Math.min(MAX[event], (tally.get(event) || 0) + 1));
}

// Send what's counted. sendBeacon gets through as the page goes away; a plain-text body keeps it a simple request (no
// preflight, which a beacon can't do). Kept for the next try if the browser won't queue it.
function send() {
  if (!tally.size || !navigator.sendBeacon) return;
  const body = new Blob([JSON.stringify(Object.fromEntries(tally))], { type: 'text/plain' });
  if (navigator.sendBeacon(`${API_URL}/usage`, body)) tally.clear();
}

// Counts this open, and sends the counts each time the app is hidden (switched away from, locked, or closed).
export function startUsage() {
  countUse('open');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
}
