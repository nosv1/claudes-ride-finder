// Weather along a ride: Open-Meteo's hourly forecast at points along the route, read for the
// hour you'll pass each one.
import { WEATHER } from './config.js';
import { cumulative } from './geo.js';

// Seconds from the start to each point of the path: from the router's maneuver times when it
// gave them, else in proportion to distance.
export function timesAlong(route) {
  const cum = cumulative(route.path), total = cum[cum.length - 1] || 1;
  const t = cum.map(m => route.seconds * m / total);
  const ms = route.maneuvers;
  if (ms && ms.length && ms.every(m => m.s != null)) {
    let at = 0;
    for (const m of ms) {
      const end = Math.min(m.end, cum.length - 1), a = cum[m.at], b = cum[end];
      for (let i = m.at; i <= end; i++) t[i] = at + (b > a ? m.s * (cum[i] - a) / (b - a) : 0);
      at += m.s;
    }
  }
  return t;
}

// Points about every everyKm along the route, both ends included: where (p), how far (m,
// meters) and how long after leaving (s, seconds) you'll pass each.
export function weatherPoints(route, everyKm = WEATHER.everyKm, max = WEATHER.maxPoints) {
  const cum = cumulative(route.path), total = cum[cum.length - 1];
  const n = Math.min(max - 1, Math.max(1, Math.round(total / 1000 / everyKm)));
  const t = timesAlong(route), pts = [];
  let i = 0;
  for (let k = 0; k <= n; k++) {
    while (i < cum.length - 1 && cum[i] < total * k / n) i++;
    pts.push({ p: route.path[i], m: cum[i], s: t[i] });
  }
  return pts;
}

// One request for all the points; each gets its hourly forecast (times in unix seconds), with the sunrises and
// sunsets of those days (none when the answer has no daily part).
export async function fetchForecast(points) {
  const q = new URLSearchParams({
    latitude: points.map(x => x.p[0].toFixed(3)).join(','),
    longitude: points.map(x => x.p[1].toFixed(3)).join(','),
    hourly: 'temperature_2m,precipitation_probability,wind_gusts_10m,weather_code', daily: 'sunrise,sunset',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timeformat: 'unixtime', forecast_days: String(WEATHER.days),
  });
  const res = await fetch(`${WEATHER.url}?${q}`);
  if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
  return [await res.json()].flat().map(d => {
    const ok = d.daily && Array.isArray(d.daily.sunrise) && Array.isArray(d.daily.sunset);
    return { ...d.hourly, sunrise: ok ? d.daily.sunrise : [], sunset: ok ? d.daily.sunset : [] };
  });
}

// The light when you pass (when: unix seconds): dark (after sunset, before sunrise) with that sunset; dusk (within
// duskMin before sunset) or dawn (within duskMin after sunrise), when the low sun is in your eyes and deer are out;
// or null (daylight, or no sunrise and sunset known for then). sun: { sunrise, sunset } in unix seconds.
export function lightAt(when, sun) {
  const events = [...(sun.sunrise || []).map(t => ({ t, set: false })), ...(sun.sunset || []).map(t => ({ t, set: true }))]
    .sort((a, b) => a.t - b.t);
  const last = events.filter(e => e.t <= when).pop(), next = events.find(e => e.t > when), margin = WEATHER.duskMin * 60;
  if (!last) return null;
  if (last.set) return { light: 'dark', sunset: last.t };
  if (next && next.set && next.t - when <= margin) return { light: 'dusk', sunset: next.t };
  return when - last.t <= margin ? { light: 'dawn', sunrise: last.t } : null;
}

// Each point's forecast for the hour it's passed, leaving at `leave` (ms). `none` past the
// forecast's end (or before its start).
export function atPassing(points, hourly, leave) {
  return points.map((x, i) => {
    const hr = hourly[i], when = leave / 1000 + x.s, j = Math.round((when - hr.time[0]) / 3600);
    const row = { ...x, when: when * 1000, sun: lightAt(when, hr) };
    if (j < 0 || j >= hr.time.length || hr.temperature_2m[j] == null) return { ...row, none: true };
    return { ...row, temp: hr.temperature_2m[j], rain: hr.precipitation_probability[j] ?? null,
      gust: hr.wind_gusts_10m[j], code: hr.weather_code[j] };
  });
}

// Riding in the dark, else near sunset or sunrise: one warning, at the first point it's so. `sunset` (unix seconds)
// so the page can say when.
function lightWarnings(rows) {
  const dark = rows.find(r => r.sun && r.sun.light === 'dark');
  if (dark) return [{ text: 'After dark', at: dark, sunset: dark.sun.sunset }];
  const low = rows.find(r => r.sun);
  if (!low) return [];
  return [low.sun.light === 'dusk' ? { text: 'Near sunset, when deer are out', at: low, sunset: low.sun.sunset }
    : { text: 'Near sunrise, when deer are out', at: low }];
}

// WMO weather codes, by the lowest code of each kind.
const SKY = [[0, 'Clear', '☀️'], [1, 'Mostly clear', '🌤️'], [2, 'Partly cloudy', '⛅'], [3, 'Cloudy', '☁️'],
  [45, 'Fog', '🌫️'], [51, 'Drizzle', '🌦️'], [61, 'Rain', '🌧️'], [71, 'Snow', '🌨️'], [80, 'Showers', '🌦️'],
  [85, 'Snow showers', '🌨️'], [95, 'Thunderstorms', '⛈️']];
export const sky = code => SKY.reduce((a, s) => code >= s[0] ? s : a, SKY[0]);

// What a rider should know, each at its worst point: storms, rain, gusts, cold, heat. With
// nothing to flag, a one-line summary instead.
export function rideWeather(rows) {
  const ok = rows.filter(r => !r.none);
  if (!ok.length) return { warnings: [], summary: null };
  const most = key => ok.filter(r => r[key] != null).reduce((a, b) => !a || b[key] > a[key] ? b : a, null);
  const temps = ok.map(r => r.temp), warnings = [];
  const storm = ok.find(r => r.code >= 95);
  if (storm) warnings.push({ text: 'Thunderstorms', at: storm });
  const wet = most('rain');
  if (wet && wet.rain >= WEATHER.rainPct) warnings.push({ text: `${wet.rain >= WEATHER.likelyPct ? 'Rain likely' : 'Rain possible'} (${wet.rain}%)`, at: wet });
  const gust = most('gust');
  if (gust && gust.gust >= WEATHER.gustMph) warnings.push({ text: `Gusts to ${Math.round(gust.gust)} mph`, at: gust });
  const cold = ok.reduce((a, b) => b.temp < a.temp ? b : a), hot = most('temp');
  if (cold.temp <= WEATHER.coldF) warnings.push({ text: `Cold: ${Math.round(cold.temp)}°F`, at: cold });
  if (hot.temp >= WEATHER.hotF) warnings.push({ text: `Hot: ${Math.round(hot.temp)}°F`, at: hot });
  warnings.push(...lightWarnings(ok));
  const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps));
  const summary = `${lo === hi ? `${lo}°F` : `${lo}–${hi}°F`}, rain chance up to ${wet ? wet.rain : 0}%, gusts to ${gust ? Math.round(gust.gust) : 0} mph`;
  return { warnings, summary, partial: ok.length < rows.length };
}
