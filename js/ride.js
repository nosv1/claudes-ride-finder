// Ride mode: turn-by-turn on the planned ride, in the app. The map follows your GPS heading-up, a banner shows the next
// turn and a voice says it. It follows the ride's line, not its stops (nav.js), so there's nothing to remove as you go:
// skip a part and it picks you up where you're back on it; leave the ride and it routes you back on ahead of you.
// A web app only runs in front, so the screen is kept awake (phone mounted, on a charger).
import { NAV } from './config.js';
import { Guide, callout, shown } from './nav.js';
import { bearing, distance, relAngle, miles, fmtDuration } from './geo.js';
import { turnArrow, turnOnto, turn } from './fly.js';
import { icon, h, toast } from './ui.js';
import { TAGS } from './tags.js';
import { speak, hush, preload } from './voice.js';

// What Ride mode says besides the turns: the words (for the phone's voice) and the recorded clip.
const LINES = {
  start: 'Starting your ride.', detour: 'Here’s a way back to your ride.', skipahead: 'Finding a way back further on.',
  voiceon: 'Voice on.', off: 'You’re off the ride. Finding a way back.', back: 'Back on your ride.',
  skipped: 'Picking up your ride from here.', crest: 'Blind crest ahead.',
  arrive: 'You’ve arrived. Nice ride.', arriveloop: 'You’re back where you started. Nice ride.',
};
const line = k => ({ text: LINES[k], clips: [k] });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Closer in slow and twisty, further out at highway speed.
const zoomFor = mps => clamp(17.2 - (mps || 0) / 15, 15, 17.2);

export class Ride {
  // route: the planned ride. reroute(p, heading, target): a route from p onto the ride at target ({ p, heading }), or
  // null. roadAt(p, heading): the road there ({ ref, name, limit, posted }) or null. crests: [{ mile }] on the ride.
  // tagRoad(k, p, heading): tag the road you're on, returning its name (or null if there's no mapped road there).
  // voice: start with it on; onVoice(on) when it's switched. loop: the ride ends where it started. onClose().
  constructor(mapView, { route, reroute, roadAt, crests, tagRoad, voice = true, onVoice = () => {}, loop = false, onClose }) {
    this.mapView = mapView;
    this.map = mapView.map;
    this.route = route;
    this.roadAt = roadAt || (() => null);
    this.tagRoad = tagRoad;
    this.voice = voice;
    this.onVoice = onVoice;
    this.loop = loop;
    this.onClose = onClose;
    this.crests = (crests || []).map(c => ({ m: c.mile * 1609.34 }));
    this.guide = new Guide(route, { reroute, onDetour: () => { this.say(line('detour')); this.showDetour(); this.update(); } });
    this.fix = null;          // the latest GPS fix
    this.shownAt = null;      // where the arrow is drawn, gliding from fix to fix
    this.glide = null;        // { from, to, t0, ms }
    this.heading = null;      // the way you're going, as drawn (eases toward the latest)
    this.zoomOff = 0;         // a zoom by hand, kept on top of the speed's
    this.following = true;
    this.ridden = 0;
    this.t0 = Date.now();
    this.build();
    document.body.classList.add('riding');
    this.saved = { pitch: this.map.getPitch(), bearing: this.map.getBearing() };
    this.pad();
    this.resize = () => this.pad();
    addEventListener('resize', this.resize);
    // A finger (or mouse) on the map holds the camera still while it's down: the camera moving every frame would cancel
    // a drag as it starts. A drag stops following (Recenter brings it back); a tap doesn't; a zoom by hand is kept.
    this.press = () => { this.held = true; };
    this.release = () => { this.held = false; };
    this.map.getCanvasContainer().addEventListener('pointerdown', this.press);
    for (const type of ['pointerup', 'pointercancel', 'touchend']) addEventListener(type, this.release);
    this.dragged = e => { if (e.originalEvent) this.follow(false); };
    this.zoomed = e => { if (e.originalEvent && this.following) this.zoomOff = this.map.getZoom() - zoomFor(this.fix && this.fix.speed); };
    this.map.on('dragstart', this.dragged);
    this.map.on('zoomend', this.zoomed);
    this.awake = () => { if (!document.hidden) this.keepAwake(); };
    document.addEventListener('visibilitychange', this.awake);
    this.keepAwake();
    this.say(line('start'));  // in the tap that opened Ride mode: iPhones only play sound once a tap has let them
    preload();  // every clip, while there's signal
    this.watch = navigator.geolocation ? navigator.geolocation.watchPosition(p => this.onFix(p), e => this.gpsError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }) : null;
    if (this.watch == null) this.gpsError({ code: 2 });
    this.raf = requestAnimationFrame(t => this.frame(t));
    this.update();
  }

  // You sit low on the screen, so most of it is the road ahead.
  pad() { this.map.setPadding({ top: Math.round(innerHeight * 0.42), bottom: 0, left: 0, right: 0 }); }

  build() {
    this.arrowEl = h('div.ride-arrow');
    this.distEl = h('div.ride-dist');
    this.ontoEl = h('div.ride-onto');
    this.thenEl = h('div.ride-then', { hidden: true });
    this.skipBtn = h('button.btn.small.ride-skip', { hidden: true, onclick: () => { this.guide.skip(); this.say(line('skipahead')); this.update(); } }, 'Skip ahead');
    this.banner = h('div.ride-banner', {}, h('div.ride-next', {}, this.arrowEl, h('div.ride-words', {}, this.distEl, this.ontoEl)),
      this.thenEl, this.skipBtn);
    this.crestEl = h('div.fly-crest.ride-crest', { hidden: true });
    this.roadEl = h('div.ride-road');
    this.speedEl = h('div.ride-speed');
    this.limitEl = h('div.fly-limit.ride-limit', { hidden: true });
    this.leftEl = h('div.ride-left');
    this.voiceBtn = h('button.btn.ride-btn', { onclick: () => this.setVoice(!this.voice) });
    this.endBtn = h('button.btn.ride-btn.end', { onclick: () => this.end() }, h('span', { html: icon.x }), 'End');
    this.recenterBtn = h('button.btn.primary.ride-recenter', { hidden: true, onclick: () => this.follow(true) }, h('span', { html: icon.go }), 'Recenter');
    this.tagSheet = h('div.ride-tags', { hidden: true },
      h('div.ride-tags-title', {}, 'Tag the road you’re on'),
      h('div.ride-tag-grid', {}, ['rough', 'gravel', 'avoid', 'great'].map(k => {
        const t = TAGS.find(x => x.k === k);
        return h('button.ride-tag', { style: `--c:${t.color}`, onclick: () => this.tag(k) }, t.label);
      })),
      h('button.btn.wide', { onclick: () => { this.tagSheet.hidden = true; } }, 'Cancel'));
    this.panel = h('div.ride-panel', {},
      h('div.ride-above', {}, this.crestEl, this.recenterBtn),
      h('div.ride-status', {}, h('div.ride-here', {}, this.roadEl, this.leftEl), this.speedEl, this.limitEl),
      h('div.ride-btns', {},
        this.voiceBtn,
        h('button.btn.ride-btn', { onclick: () => { this.tagSheet.hidden = !this.tagSheet.hidden; } }, h('span', { html: icon.flag }), 'Tag road'),
        h('button.btn.ride-btn', { onclick: () => this.overview() }, h('span', { html: icon.route }), 'Overview'),
        this.endBtn));
    this.doneEl = h('div.ride-done', { hidden: true });
    document.body.append(this.banner, this.panel, this.tagSheet, this.doneEl);
    this.setVoice(this.voice, true);
  }

  setVoice(on, quiet = false) {
    this.voice = on;
    this.voiceBtn.replaceChildren(h('span', { html: on ? icon.sound : icon.mute }), on ? 'Voice on' : 'Voice off');
    if (!on) hush();
    if (!quiet) { this.onVoice(on); if (on) this.say(line('voiceon')); }
  }

  // A phrase: { text, clips }.
  say(phrase) {
    this.lastSaid = phrase.text;
    if (this.voice) speak(phrase);
  }

  async keepAwake() {
    try { if (navigator.wakeLock && !this.lock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.onrelease = () => { this.lock = null; }; } } catch (e) { /* not allowed or not supported */ }
  }

  gpsError(e) {
    this.gpsTrouble = e.code === 1 ? 'denied' : e.code === 3 ? 'slow' : 'none';
    this.update();
  }

  onFix(pos) {
    const c = pos.coords, p = [c.latitude, c.longitude], prev = this.fix, t = pos.timestamp || Date.now();
    const moved = prev ? distance(prev.p, p) : 0;
    // The speed is the phone's own, from the GPS signal (within about 1 mph under open sky, a second behind). iPhones
    // give -1 (and Android null) when they don't know it: then it's how far you went over the last few seconds.
    this.trail = [...(this.trail || []).filter(x => t - x.t < 5000), { p, t }];
    const known = Number.isFinite(c.speed) && c.speed >= 0, from = this.trail[0];
    const speed = known ? c.speed : t - from.t >= 2000 ? distance(from.p, p) / ((t - from.t) / 1000) : prev ? prev.speed : 0;
    // Phones leave out the heading (or give -1) when slow or stopped: take it from the way you moved, else keep the last.
    let heading = Number.isFinite(c.heading) && c.heading >= 0 && speed > 1 ? c.heading : null;
    if (heading == null && prev && moved > 8) heading = bearing(prev.p, p);
    if (heading == null && prev) heading = prev.heading;
    const f = { p, heading, speed, accuracy: c.accuracy || 0, t };
    if (prev && moved < 200) this.ridden += moved;
    this.fix = f;
    this.gpsTrouble = null;
    const event = this.guide.fix(f);
    if (event === 'off') this.say(line('off'));
    else if (event === 'back' || event === 'skipped') { this.say(line(event)); this.showDetour(); }
    else if (event === 'done') this.finish();
    // On the ride, the arrow sits on its line; off it, where the GPS says.
    const leg = this.guide.leg.track, at = leg.on && leg.spot && leg.spot.d < 30 ? leg.spot.p : p;
    this.glide = { from: this.shownAt || at, to: at, t0: performance.now(), ms: clamp(prev ? f.t - prev.t : 0, 300, 1500) };
    this.want = heading ?? (leg.spot && leg.spot.heading) ?? this.want ?? 0;
    if (this.guide.state === 'on' && (!this.riddenAt || Math.abs(this.guide.main.m - this.riddenAt) > 50)) this.showRidden();
    this.speak();
    this.update();
  }

  // The turn calls, and blind crests ahead.
  speak() {
    if (this.guide.done) return;
    const [next] = this.guide.upcoming(1), v = this.fix.speed;
    const call = next && callout(next.turn, next.inM, v);
    if (call) return this.say(call);
    if (this.guide.state !== 'on') return;
    const m = this.guide.main.m, c = this.crests.find(x => x.m - m > 0 && x.m - m < Math.max(150, v * 12));
    if (c && !c.said) { c.said = true; this.say(line('crest')); }
  }

  frame(now) {
    const dt = Math.min(0.1, ((now - (this.lastFrame || now)) / 1000));
    this.lastFrame = now;
    if (this.glide) {
      const g = this.glide, k = clamp((now - g.t0) / g.ms, 0, 1);
      this.shownAt = [g.from[0] + (g.to[0] - g.from[0]) * k, g.from[1] + (g.to[1] - g.from[1]) * k];
      this.heading = this.heading == null ? this.want : turn(this.heading, this.want, 1 - Math.exp(-dt / 0.7));
      this.mapView.setNavArrow(this.shownAt, this.heading);
      if (this.following && !this.held) {
        const z = zoomFor(this.fix.speed) + this.zoomOff, zNow = this.map.getZoom();
        this.map.jumpTo({ center: [this.shownAt[1], this.shownAt[0]], bearing: this.heading, pitch: 50, zoom: zNow + (z - zNow) * Math.min(1, dt * 1.5) });
      }
    }
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  follow(on) {
    this.following = on;
    this.recenterBtn.hidden = on;
    if (on) this.map.setPadding({ top: Math.round(innerHeight * 0.42), bottom: 0, left: 0, right: 0 });
  }

  // The whole ride from above (Recenter goes back to following).
  overview() {
    this.follow(false);
    const b = this.route.path.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [90, 180, -90, -180]);
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: { top: 150, bottom: 190, left: 30, right: 30 }, bearing: 0, pitch: 0, duration: 600 });
  }

  showDetour() { this.mapView.setDetour(this.guide.state === 'detour' ? this.guide.detour.route.path : null); }

  showRidden() {
    const t = this.guide.main;
    this.riddenAt = t.m;
    const i = t.path.findIndex((_, k) => t.cum[k] > t.m);
    this.mapView.setRidden([...t.path.slice(0, i < 0 ? t.path.length : i), t.pointAt(t.m)]);
  }

  tag(k) {
    this.tagSheet.hidden = true;
    const f = this.fix, name = f && this.tagRoad(k, f.p, f.heading);
    toast(name ? `${name} tagged ${TAGS.find(t => t.k === k).label}.` : f ? 'No mapped road right here to tag.' : 'Waiting for GPS to know which road you’re on.');
  }

  // End takes a second tap, so a bump on the mount doesn't end the ride.
  end() {
    if (this.guide.done) return this.close();
    if (this.ending) return this.close();
    this.ending = setTimeout(() => { this.ending = null; this.endBtn.lastChild.textContent = 'End'; this.endBtn.classList.remove('sure'); }, 3000);
    this.endBtn.lastChild.textContent = 'Tap to end';
    this.endBtn.classList.add('sure');
  }

  finish() {
    this.say(line(this.loop ? 'arriveloop' : 'arrive'));
    this.doneEl.replaceChildren(
      h('b', {}, this.loop ? 'Back where you started' : 'You made it'),
      h('div.muted', {}, `${miles(this.ridden)} mi ridden in ${fmtDuration((Date.now() - this.t0) / 1000)}`),
      h('button.btn.primary.wide', { onclick: () => this.close() }, 'Done'));
    this.doneEl.hidden = false;
    this.update();
  }

  // The banner (next turn, or what's going on) and the bar (road, speed, miles left).
  update() {
    const g = this.guide, f = this.fix, state = g.state;
    const [next, after] = g.upcoming(2);
    this.skipBtn.hidden = !(state === 'off' || state === 'detour');
    this.thenEl.hidden = true;
    this.banner.classList.toggle('off', state === 'off');
    const words = (arrow, dist, onto) => { this.arrowEl.textContent = arrow; this.distEl.textContent = dist; this.ontoEl.textContent = onto; };
    if (!f) {
      const t = this.gpsTrouble;
      words('◎', t === 'denied' ? 'Location is off' : 'Finding you…',
        t === 'denied' ? 'Allow location for this site in your phone’s settings, then start the ride again.'
          : t === 'none' ? 'This device can’t give a location.' : 'Waiting for GPS. Out in the open helps.');
    } else if (state === 'done') {
      words('⚑', this.loop ? 'Back at the start' : 'Arrived', '');
    } else if (state === 'off') {
      // No way back yet (asking, or no signal): which way the ride is, and how far.
      const to = g.target && g.target.p, d = to ? distance(f.p, to) : null;
      const dir = to && f.heading != null ? relAngle(bearing(f.p, to), f.heading) : 0;
      words('↑', 'Off your ride', d ? `${g.asking ? 'Finding a way back' : 'No way back yet (signal?)'} · the ride is ${shown(d)} that way` : 'Finding a way back…');
      this.arrowEl.style.transform = `rotate(${Math.round(dir)}deg)`;
    } else if (next) {
      words(turnArrow(next.turn.type), shown(next.inM), next.turn.type === 4 ? (this.loop ? 'Back at the start' : 'Arrive') : turnOnto(next.turn));
      if (state === 'detour') this.ontoEl.textContent += ' · on the way back to your ride';
      if (after && after.inM - next.inM < 400) {
        this.thenEl.hidden = false;
        this.thenEl.textContent = `then ${turnArrow(after.turn.type)} ${turnOnto(after.turn)}`;
      }
    } else if (state === 'detour') {
      const d = g.detour.track;
      words('↑', shown(d.total - d.m), 'and you’re back on your ride');
    } else {
      words('↑', shown(g.leftM), this.loop ? 'to the start' : 'to the end');
    }
    if (state !== 'off') this.arrowEl.style.transform = '';
    // The bar.
    const here = f && this.roadAt(f.p, f.heading ?? 0);
    this.roadEl.replaceChildren(...(here ? [here.ref ? h('span.fly-ref', {}, here.ref.split(' / ')[0]) : '', h('span.fly-name', {}, here.name || '')] : []));
    this.limitEl.hidden = !(here && here.limit);
    if (here && here.limit) {
      this.limitEl.classList.toggle('est', !here.posted);
      this.limitEl.replaceChildren(h('small', {}, here.posted ? 'SPEED LIMIT' : 'ABOUT'), h('b', {}, `${here.limit}`));
    }
    // A rough fix (worse than 50 m) can't tell speed.
    this.speedEl.replaceChildren(h('b', {}, f && f.accuracy <= 50 ? `${Math.round(f.speed * 2.237)}` : '–'), h('small', {}, 'mph'));
    const leftS = this.route.seconds * g.leftM / Math.max(1, g.main.total);
    this.leftEl.textContent = state === 'done' ? `${miles(this.ridden)} mi ridden` : `${miles(g.leftM)} mi left · ${this.loop ? 'back' : 'there'} about ${clock(Date.now() + leftS * 1000)}`;
    const m = g.main.m, crest = state === 'on' && this.crests.find(c => c.m - m > -30 && c.m - m < NAV.crestM);
    this.crestEl.hidden = !crest;
    if (crest) this.crestEl.textContent = crest.m - m > 30 ? `⚠ Blind crest ahead · ${Math.round((crest.m - m) * 3.281 / 10) * 10} ft` : '⚠ Blind crest';
  }

  close() {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.ending);
    hush();
    if (this.lock) this.lock.release().catch(() => {});
    document.removeEventListener('visibilitychange', this.awake);
    removeEventListener('resize', this.resize);
    this.map.off('dragstart', this.dragged);
    this.map.getCanvasContainer().removeEventListener('pointerdown', this.press);
    for (const type of ['pointerup', 'pointercancel', 'touchend']) removeEventListener(type, this.release);
    this.map.off('zoomend', this.zoomed);
    for (const el of [this.banner, this.panel, this.tagSheet, this.doneEl]) el.remove();
    document.body.classList.remove('riding');
    this.mapView.setNavArrow(null);
    this.mapView.setDetour(null);
    this.mapView.setRidden(null);
    this.map.jumpTo({ pitch: this.saved.pitch, bearing: this.saved.bearing });
    this.onClose();
  }
}
