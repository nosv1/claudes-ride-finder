// Fly-through: a 3D camera that rides a planned route, looking ahead, with play/pause, speed,
// the elevation chart as a scrubber, and blind crests called out as they come up.
import { FLY, TERRAIN } from './config.js';
import { cumulative, bearing, miles, fmtDuration } from './geo.js';
import { timesAlong } from './weather.js';
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

// A heading turned part of the way (k, 0–1) toward another, the short way around.
export const turn = (from, to, k) => (from + ((to - from + 540) % 360 - 180) * k + 360) % 360;

export class Fly {
  // crests: [{ mile }] along the route; profile: the elevation profile, or null; roadAt: the
  // road at a point as { name, curvy }, if known (else the router's street names are used).
  constructor(mapView, { route, profile, crests, roadAt, onClose }) {
    this.mapView = mapView;
    this.map = mapView.map;
    this.route = route;
    this.f = flight(route);
    this.profile = profile;
    this.crests = (crests || []).map(c => c.mile * 1609.34);
    this.onClose = onClose;
    this.roadAt = roadAt || (() => null);
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
      h('div.fly-controls', {}, this.playBtn, this.speedBtn,
        h('span.muted.small', {}, `${miles(this.f.total)} mi · ${fmtDuration(this.f.seconds)} of riding`)));
    document.body.append(this.bar);
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
    this.now.style.left = `${m / this.f.total * 100}%`;
    if (this.slider) this.slider.value = Math.round(this.s / this.f.seconds * 1000);
    // What's under the rider, and the text, a few times a second is plenty.
    const due = !dt || performance.now() - this.shown >= 250;
    if (due) {
      this.here = this.roadAt(p);
      this.liftTo = this.here && this.here.curvy ? FLY.exaggeration : FLY.flatExaggeration;
    }
    this.terrainLift(dt);
    if (!due) return;
    this.shown = performance.now();
    const at = this.f.index(m), man = (this.route.maneuvers || []).find(x => at >= x.at && at < x.end);
    const road = (this.here && this.here.name) || (man ? routeRefs(man).join(' / ') || man.names[0] || '' : '');
    const sample = this.profile && this.profile.samples[Math.round(m / this.f.total * (this.profile.samples.length - 1))];
    this.readout.replaceChildren(
      h('b', {}, `Mile ${miles(m)}`), ` · ${fmtDuration(this.s)} in`,
      road ? h('span', {}, ` · ${road}`) : '',
      sample ? ` · ${Math.round(sample.ft).toLocaleString()} ft` : '');
    const crest = this.crests.find(c => c - m > -40 && c - m < FLY.crestM);
    this.callout.hidden = crest == null;
    if (crest != null) this.callout.textContent = crest - m > 30 ? `⚠ Blind crest ahead · ${Math.round((crest - m) * 3.281 / 10) * 10} ft` : '⚠ Blind crest';
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
    document.body.classList.remove('flying');
    this.mapView.setRider(null);
    this.mapView.showRoadMarks(true);
    this.map.setTerrain(this.saved.terrain);
    this.map.jumpTo({ pitch: this.saved.pitch, bearing: this.saved.bearing });
    this.map.setMaxPitch(this.saved.maxPitch);
    this.onClose();
  }
}
