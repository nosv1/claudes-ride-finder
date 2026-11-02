// Fly-through: a 3D camera that rides a planned route, looking ahead, with play/pause, speed,
// the elevation chart as a scrubber, and blind crests called out as they come up.
import { FLY, TERRAIN, WEATHER } from './config.js';
import { cumulative, bearing, miles, fmtDuration, boundsOf, nearestIndex } from './geo.js';
import { timesAlong, sky } from './weather.js';
import { routeRefs } from './routing.js';
import { icon, h, elevationChart } from './ui.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Index i with arr[i] <= v < arr[i + 1] (arr ascending), and how far v is between them.
function bracket(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  const span = arr[lo + 1] - arr[lo];
  return { i: lo, f: span > 0 ? clamp((v - arr[lo]) / span, 0, 1) : 0 };
}

// A route as something to play: where the rider is (meters along) at each second of riding,
// and back, the point at any meters, and which way to look from there.
export function flight(route) {
  const path = route.path, cum = cumulative(path), t = timesAlong(route);
  const total = cum[cum.length - 1], seconds = t[t.length - 1];
  const map = (from, to, v) => {
    if (path.length < 2) return 0;
    const { i, f } = bracket(from, v);
    return to[i] + (to[i + 1] - to[i]) * f;
  };
  const pointAt = m => {
    if (path.length < 2) return path[0];
    const { i, f } = bracket(cum, clamp(m, 0, total)), a = path[i], b = path[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  return {
    total, seconds, pointAt,
    metersAtIndex: i => cum[clamp(i, 0, cum.length - 1)],
    metersAt: s => map(t, cum, clamp(s, 0, seconds)),
    secondsAt: m => map(cum, t, clamp(m, 0, total)),
    index: m => bracket(cum, clamp(m, 0, total)).i,
    // Toward the route `ahead` meters on (near the end, along its last stretch).
    lookFrom: (m, ahead) => {
      const from = clamp(Math.min(m, total - ahead), 0, total);
      return bearing(pointAt(from), pointAt(from + ahead));
    },
  };
}

// Valhalla maneuvers that aren't a turn to call out: starts and arrivals (every stop is one),
// "becomes", "continue", "stay straight".
const NOT_TURNS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 22]);

// The next turn after path index `at`, or null.
export const nextTurn = (maneuvers, at) => (maneuvers || []).find(x => x.at > at && !NOT_TURNS.has(x.type) && x.text) || null;

// The road's grade in % at meters m (up positive), over about ±halfM; null without a profile.
export function gradeAt(profile, m, halfM = 150) {
  if (!profile) return null;
  const s = profile.samples, n = s.length - 1, step = profile.meters / n || 1;
  const j = Math.round(m / step), k = Math.max(1, Math.round(halfM / step));
  const a = s[clamp(j - k, 0, n)], b = s[clamp(j + k, 0, n)];
  return b.m > a.m ? (b.ft - a.ft) / 3.281 / (b.m - a.m) * 100 : 0;
}

// A heading turned part of the way (k, 0–1) toward another, the short way around.
export const turn = (from, to, k) => (from + ((to - from + 540) % 360 - 180) * k + 360) % 360;

export class Fly {
  // crests: [{ mile }] along the route; profile: the elevation profile, or null; roadAt(p, heading):
  // the road there as { ref, name, curvy, limit, posted }, if known (else the router's names);
  // weatherAt(m, s): the forecast row (weather.js atPassing) at meters m, s seconds into the ride.
  constructor(mapView, { route, profile, crests, roadAt, weatherAt, onClose }) {
    this.mapView = mapView;
    this.map = mapView.map;
    this.route = route;
    this.f = flight(route);
    this.profile = profile;
    this.crests = (crests || []).map(c => c.mile * 1609.34);
    this.onClose = onClose;
    this.roadAt = roadAt || (() => null);
    this.weatherAt = weatherAt || (() => null);
    this.shown = 0;
    this.lift = this.liftTo = FLY.exaggeration;  // how much taller than life the terrain is drawn
    this.speed = FLY.speed;
    this.s = 0;
    this.heading = null;
    this.pitch = innerHeight > innerWidth ? FLY.pitchTall : FLY.pitch;  // a tall phone screen: less sky
    this.playing = false;
    this.raf = null;
    this.saved = { pitch: this.map.getPitch(), bearing: this.map.getBearing(), maxPitch: this.map.getMaxPitch(), terrain: this.map.getTerrain() };
    this.key = e => {
      if (e.key === 'Escape') this.close();
      else if (e.key === ' ' && !e.target.closest('input, button')) { e.preventDefault(); this.toggle(); }
    };
    this.build();
    this.resize = () => this.pad();
    // Asked for every frame: the map lowers the tilt when the camera would be inside a hill (or
    // looks it, before the terrain there has loaded). A tilt by hand is kept.
    this.tilted = e => { if (e.originalEvent) this.pitch = this.map.getPitch(); };
    this.map.on('pitchend', this.tilted);
    document.addEventListener('keydown', this.key);
    addEventListener('resize', this.resize);
    document.body.classList.add('flying');
    this.map.setMaxPitch(TERRAIN.maxPitch);
    this.map.setTerrain({ source: 'dem', exaggeration: this.lift });
    mapView.showRoadMarks(false);
    this.pad();
    const p = this.f.pointAt(0);
    this.heading = this.f.lookFrom(0, FLY.aheadM);
    this.map.jumpTo({ center: [p[1], p[0]], zoom: FLY.zoom, pitch: this.pitch, bearing: this.heading });
    this.draw();
    this.play();
  }

  // The rider sits low on the screen (still above the bar), so most of the view is the road
  // ahead. Only top padding: more padding lowers how far the map lets the camera tilt.
  pad() {
    this.map.setPadding({ top: Math.round(innerHeight * 0.4), bottom: 0, left: 0, right: 0 });
  }

  build() {
    this.playBtn = h('button.icon-btn.fly-play', { title: 'Play / pause (space)', onclick: () => this.toggle() });
    this.speedBtn = h('button.btn.small.fly-speed', { title: 'Speed, times real riding time', onclick: () => {
      const s = FLY.speeds;
      this.speed = s[(s.indexOf(this.speed) + 1) % s.length];
      this.speedBtn.textContent = `${this.speed}×`;
    } }, `${this.speed}×`);
    this.readout = h('div.fly-readout');
    this.callout = h('div.fly-crest', { hidden: true });
    this.sign = h('div.fly-road');
    this.turnEl = h('div.fly-turn', { hidden: true });
    this.limitEl = h('div.fly-limit', { hidden: true });
    this.paceEl = h('span.fly-pace');
    this.wxEl = h('div.fly-wx', { hidden: true });
    this.mini = this.miniMap();
    this.hud = h('div.fly-hud', {}, h('div.fly-hud-left', {}, this.sign, this.turnEl, this.wxEl),
      h('div.fly-hud-right', {}, this.limitEl, this.mini));
    this.now = h('div.fly-now');
    let down = false;
    const chart = this.profile ? elevationChart(this.profile, s => { if (down && s) this.seek(this.f.secondsAt(s.m)); }) : null;
    if (chart) {
      chart.classList.add('fly-chart');
      chart.append(this.now);
      // Capture: before the chart's own pointerdown, which reports the spot (and so seeks).
      chart.addEventListener('pointerdown', () => { down = true; this.wasPlaying = this.playing; this.pause(); }, true);
      addEventListener('pointerup', this.up = () => { if (down) { down = false; if (this.wasPlaying) this.play(); } });
    }
    this.slider = chart ? null : h('input.fly-slider', { type: 'range', min: 0, max: 1000, value: 0,
      oninput: e => this.seek(this.f.seconds * e.target.value / 1000) });
    this.bar = h('div.fly-bar', {},
      this.callout,
      h('div.fly-top', {}, this.readout, h('button.icon-btn', { title: 'Close (Esc)', html: icon.x, onclick: () => this.close() })),
      chart || this.slider,
      h('div.fly-controls', {}, this.playBtn, this.speedBtn, this.paceEl,
        h('span.muted.small.grow', {}, `${miles(this.f.total)} mi · ${fmtDuration(this.f.seconds)}`)));
    document.body.append(this.hud, this.bar);
  }

  play() {
    if (this.s >= this.f.seconds - 0.5) this.s = 0;
    this.playing = true;
    this.map.dragPan.disable();
    this.playBtn.innerHTML = icon.pause;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(now => this.frame(now));
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.map.dragPan.enable();
    this.playBtn.innerHTML = icon.play;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(s) {
    this.s = clamp(s, 0, this.f.seconds);
    this.heading = null;  // look straight down the road from the new spot
    this.draw();
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.s += dt * this.speed;
    if (this.s >= this.f.seconds) { this.s = this.f.seconds; this.draw(dt); return this.pause(); }
    this.draw(dt);
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  // Camera, rider dot and readout for the current moment. dt: seconds since the last frame,
  // for easing the turn (none: face the road at once).
  draw(dt) {
    const m = this.f.metersAt(this.s), p = this.f.pointAt(m), want = this.f.lookFrom(m, FLY.aheadM);
    this.heading = this.heading == null || !dt ? want : turn(this.heading, want, 1 - Math.exp(-dt / FLY.turnS));
    this.map.jumpTo({ center: [p[1], p[0]], bearing: this.heading, pitch: this.pitch });
    this.mapView.setRider(p);
    this.miniDot.setAttribute('cx', this.miniX(p[1]).toFixed(1));
    this.miniDot.setAttribute('cy', this.miniY(p[0]).toFixed(1));
    this.now.style.left = `${m / this.f.total * 100}%`;
    if (this.slider) this.slider.value = Math.round(this.s / this.f.seconds * 1000);
    // What's under the rider, and the text, a few times a second is plenty.
    const due = !dt || performance.now() - this.shown >= 250;
    if (due) {
      this.here = this.roadAt(p, this.f.lookFrom(m, 40));
      this.liftTo = this.here && this.here.curvy ? FLY.exaggeration : FLY.flatExaggeration;
    }
    this.terrainLift(dt);
    if (!due) return;
    this.shown = performance.now();
    const at = this.f.index(m), man = (this.route.maneuvers || []).find(x => at >= x.at && at < x.end);
    this.showRoad(this.here, man);
    this.showTurn(at, m);
    this.showWeather(m);
    // The pace the router expects here: what the playback runs at, times the speed button.
    const mph = man && man.s > 0 ? man.km / man.s * 3600 / 1.609 : null;
    this.paceEl.textContent = mph ? `riding ~${Math.round(mph)} mph` : '';
    const sample = this.profile && this.profile.samples[Math.round(m / this.f.total * (this.profile.samples.length - 1))];
    const grade = gradeAt(this.profile, m);
    this.readout.replaceChildren(
      h('b', {}, `Mile ${miles(m)}`), ` · ${fmtDuration(this.s)} in`,
      sample ? ` · ${Math.round(sample.ft).toLocaleString()} ft` : '',
      grade != null && Math.abs(grade) >= 3 ? h('span.fly-grade', {}, ` · ${grade > 0 ? '↗' : '↘'} ${Math.round(Math.abs(grade))}%`) : '');
    const crest = this.crests.find(c => c - m > -40 && c - m < FLY.crestM);
    this.callout.hidden = crest == null;
    if (crest != null) this.callout.textContent = crest - m > 30 ? `⚠ Blind crest ahead · ${Math.round((crest - m) * 3.281 / 10) * 10} ft` : '⚠ Blind crest';
  }

  // The road sign (route number and name) and its speed limit: from our road data under the
  // rider, else the router's street names (and no limit).
  showRoad(here, man) {
    const refs = man ? routeRefs(man) : [], names = man ? man.names.filter(n => !routeRefs({ names: [n] }).length) : [];
    const ref = here ? here.ref : refs[0], name = here ? here.name : names[0];
    this.sign.replaceChildren(ref ? h('span.fly-ref', {}, ref) : '', name && name !== ref ? h('span.fly-name', {}, name) : '');
    this.sign.hidden = !ref && !name;
    const limit = here && here.limit;
    this.limitEl.hidden = !limit;
    if (limit) {
      this.limitEl.classList.toggle('est', !here.posted);
      this.limitEl.replaceChildren(h('small', {}, here.posted ? 'SPEED LIMIT' : 'LIKELY'), h('b', {}, limit));
      this.limitEl.title = here.posted ? 'Posted speed limit' : 'No posted limit in OpenStreetMap: the usual limit for this kind of road';
    }
  }

  // The whole ride, north up, with the rider on it; a tap there jumps the ride to that spot.
  miniMap() {
    const path = this.route.path, b = boundsOf(path), k = Math.cos((b[0] + b[2]) / 2 * Math.PI / 180);
    const w = (b[3] - b[1]) * k || 1e-6, ht = b[2] - b[0] || 1e-6, S = 100 / Math.max(w, ht);
    this.miniX = lon => (lon - b[1]) * k * S + (100 - w * S) / 2;
    this.miniY = lat => (b[2] - lat) * S + (100 - ht * S) / 2;
    const step = Math.max(1, Math.floor(path.length / 500));
    const line = path.filter((_, i) => i % step === 0).concat([path[path.length - 1]])
      .map(p => `${this.miniX(p[1]).toFixed(1)},${this.miniY(p[0]).toFixed(1)}`).join(' ');
    const el = h('div.fly-mini', { title: 'The whole ride: tap to jump there' });
    el.innerHTML = `<svg viewBox="-8 -8 116 116"><polyline points="${line}" fill="none" stroke="#4dabf7" stroke-width="3"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${this.miniX(path[0][1]).toFixed(1)}" cy="${this.miniY(path[0][0]).toFixed(1)}" r="4" fill="#fff"/>
      <circle class="dot" r="6" fill="#ffd43b" stroke="#111" stroke-width="2"/></svg>`;
    this.miniDot = el.querySelector('.dot');
    el.addEventListener('click', e => {
      const box = el.querySelector('svg').getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width * 116 - 8, y = (e.clientY - box.top) / box.height * 116 - 8;
      const at = [b[2] - (y - (100 - ht * S) / 2) / S, b[1] + (x - (100 - w * S) / 2) / S / k];
      this.seek(this.f.secondsAt(this.f.metersAtIndex(nearestIndex(path, at))));
    });
    return el;
  }

  // The forecast here, for when you'd be here: the clock time, sky, temperature, rain, gusts.
  showWeather(m) {
    const r = this.weatherAt(m, this.s);
    this.wxEl.hidden = !r || r.none;
    if (!r || r.none) return;
    const bad = r.code >= 95 || r.rain >= WEATHER.rainPct || r.gust >= WEATHER.gustMph || r.temp <= WEATHER.coldF || r.temp >= WEATHER.hotF;
    this.wxEl.classList.toggle('warn', bad);
    this.wxEl.replaceChildren(
      h('b', {}, new Date(r.when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
      ` ${sky(r.code)[2]} ${Math.round(r.temp)}°F · rain ${r.rain ?? 0}%`, r.gust >= 20 ? ` · gusts ${Math.round(r.gust)} mph` : '');
    this.wxEl.title = `${sky(r.code)[1]}: the forecast here for when you'd be here, leaving at the time set under Weather`;
  }

  // The next turn, from a mile and a half out.
  showTurn(at, m) {
    const t = nextTurn(this.route.maneuvers, at), d = t ? this.f.metersAtIndex(t.at) - m : Infinity;
    this.turnEl.hidden = d > 2400;
    if (d <= 2400) this.turnEl.replaceChildren(h('b', {}, d < 50 ? 'Now' : `In ${miles(d)} mi`), ` ${t.text}`);
  }

  // Tall hills on back roads, where they're the point. On highways and in town the terrain data
  // has no bridges (an overpass is the ground under it) and cuts and fills look like canyons
  // when exaggerated, so it eases down there. MapLibre reads the terrain's exaggeration every
  // frame, so changing it in place is smooth (setTerrain would rebuild the terrain).
  terrainLift(dt) {
    this.lift += (this.liftTo - this.lift) * (dt ? 1 - Math.exp(-dt / FLY.liftS) : 1);
    if (this.map.terrain) this.map.terrain.exaggeration = this.lift;
  }

  close() {
    this.pause();
    document.removeEventListener('keydown', this.key);
    removeEventListener('resize', this.resize);
    this.map.off('pitchend', this.tilted);
    if (this.up) removeEventListener('pointerup', this.up);
    this.bar.remove();
    this.hud.remove();
    document.body.classList.remove('flying');
    this.mapView.setRider(null);
    this.mapView.showRoadMarks(true);
    this.map.setTerrain(this.saved.terrain);
    this.map.jumpTo({ pitch: this.saved.pitch, bearing: this.saved.bearing });
    this.map.setMaxPitch(this.saved.maxPitch);
    this.onClose();
  }
}
