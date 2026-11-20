// The usage page (usage/index.html): the API's last 30 days of counts (js/usage.js sends them) as totals and a
// table by day. Read only; nothing here is counted. The owner only: the API wants the usage key, which comes in the
// link once (usage/#key=…) and is kept in this browser, out of the address bar.
import { API_URL } from './config.js';
import { check } from './check.js';

const DAY = 86400e3, SHOW = 30, KEY = 'rf-usage-key';
const ROUTES = ['route-fossgis', 'route-stadia', 'route-osrm', 'route-none'];
const COLUMNS = ['open', 'generate', 'ride', 'routes', ...ROUTES];

const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
const fmt = n => n.toLocaleString('en-US');
const dateOf = day => new Date(day * DAY).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

// One day's counts with every column filled (0 when nothing came in), and its routes added up.
function dayRow(counts) {
  const row = {};
  for (const k of COLUMNS) row[k] = counts?.[k] || 0;
  row.routes = ROUTES.reduce((sum, k) => sum + row[k], 0);
  return row;
}

function tile(n, what, sub) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = '<div class="n"></div><div class="what"></div><div class="sub"></div>';
  el.children[0].textContent = fmt(n);
  el.children[1].textContent = what;
  el.children[2].textContent = sub;
  return el;
}

const share = (part, whole) => whole ? `${Math.round(100 * part / whole)}%` : '–';

function showTotals(rows) {
  const t = dayRow(null);
  for (const r of rows) for (const k of COLUMNS) t[k] += r[k];
  $('tiles').replaceChildren(
    tile(t.open, 'App opens', 'Each time the app is opened'),
    tile(t.generate, 'Rides generated', 'Taps of Generate'),
    tile(t.ride, 'Ride mode', 'Rides started with guidance'),
    tile(t.routes, 'Routes asked for', t.routes ? `Public ${share(t['route-fossgis'], t.routes)} · Stadia ${share(t['route-stadia'], t.routes)} · failed ${share(t['route-none'], t.routes)}` : 'None yet'),
  );
  $('tiles').hidden = false;
}

function showDays(today, rows) {
  const trs = rows.map((r, i) => {
    const tr = document.createElement('tr'), th = document.createElement('td');
    th.textContent = dateOf(today - i);
    tr.append(th, ...COLUMNS.map(k => {
      const td = document.createElement('td');
      td.textContent = fmt(r[k]);
      if (!r[k]) td.className = 'zero';
      return td;
    }));
    return tr;
  });
  $('rows').replaceChildren(...trs);
  $('days').hidden = false;
}

// The key from the link (kept, and taken out of the address bar), else the one kept from before. Null if neither.
function usageKey() {
  const given = new URLSearchParams(location.hash.slice(1)).get('key');
  try {
    if (given) {
      localStorage.setItem(KEY, given);
      history.replaceState(null, '', location.pathname);
    }
    return given || localStorage.getItem(KEY);
  } catch (e) {
    console.warn('No stored usage key', e);
    return given;
  }
}

async function load() {
  const key = usageKey();
  if (!key) {
    $('status').textContent = 'This page is private. Open it with your usage link (usage/#key=…).';
    return;
  }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${API_URL}/usage`, { signal: ctl.signal, headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (res.status === 401 || res.status === 503) {
      $('status').textContent = data.error || 'That usage key didn’t work.';
      return;
    }
    if (!check(res.ok && Number.isInteger(data.today) && data.days && typeof data.days === 'object', 'usage from the API')) {
      $('status').textContent = 'The usage numbers aren’t available right now.';
      return;
    }
    const rows = Array.from({ length: SHOW }, (_, i) => dayRow(data.days[data.today - i]));
    showTotals(rows);
    showDays(data.today, rows);
    $('status').hidden = true;
  } catch (e) {
    console.warn('No usage', e);
    $('status').textContent = 'Couldn’t reach the usage numbers. Try again in a minute.';
  } finally {
    clearTimeout(timer);
  }
}

void load();  // it shows its own failures (and below)
addEventListener('hashchange', () => void load());  // a key pasted onto the page while it's open
