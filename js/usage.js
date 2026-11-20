// Usage counts for the public usage page (usage/): how often things happen, never who. Counted here and sent as
// one small note to the accounts API when the app goes to the background (or closes), so a Generate's many routes
// cost one request, not one each. Nothing about the rider goes with it: just { event: how many }.
import { API_URL } from './config.js';
import { check } from './check.js';

// What's counted. The API refuses anything else (worker/src/index.js, USAGE_EVENTS).
export const USAGE_EVENTS = ['open', 'generate', 'ride', 'route-fossgis', 'route-stadia', 'route-osrm', 'route-none'];
const MAX = 1000;  // of one event in a note: the API's cap

// Counts not sent yet: event → how many. One entry an event at most, each capped at MAX.
const tally = new Map();

export function countUse(event) {
  if (!check(USAGE_EVENTS.includes(event), `a usage event: ${event}`)) return;
  tally.set(event, Math.min(MAX, (tally.get(event) || 0) + 1));
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
