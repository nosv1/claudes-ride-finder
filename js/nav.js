// Ride mode's sense of where you are on a ride: how far along it each GPS fix puts you, when you've left it, where to
// get back on (ahead of you, never back to a stop you skipped), and what to say about each turn. It follows the ride's
// line, not its stops, so there's nothing to remove as you go. Pure: no DOM, no map library.
import { NAV } from './config.js';
import { bearing, cumulative, relAngle } from './geo.js';

const RAD = Math.PI / 180, M_PER_DEG = 111195;

// Flat metres between two nearby points (plenty for metres off a road).
const flat = (a, b) => Math.hypot((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) * M_PER_DEG;

// The spot on segment a–b nearest p: { t (0–1), p, d (metres) }.
function onSegment(a, b, p) {
  const k = Math.cos(p[0] * RAD), dx = (b[1] - a[1]) * k, dy = b[0] - a[0], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[1] - a[1]) * k * dx + (p[0] - a[0]) * dy) / len)) : 0;
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, p: q, d: flat(q, p) };
}

// Index i with cum[i] <= m < cum[i + 1].
function indexAt(cum, m) {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= m) lo = mid; else hi = mid;
  }
  return lo;
}

// Following one route: metres along it (m), metres off it (d), and whether you're on it (null before the first fix).
export class Track {
  constructor(path) {
    this.path = path;
    this.cum = cumulative(path);
    this.total = this.cum[this.cum.length - 1] || 0;
    this.loop = path.length > 1 && flat(path[0], path[path.length - 1]) < 1000;  // ends about where it starts
    this.m = 0;
    this.d = Infinity;
    this.on = null;
    this.offFixes = 0;
    this.jumped = 0;
    this.spot = null;
  }

  pointAt(m) {
    if (this.path.length < 2) return this.path[0];
    const i = indexAt(this.cum, Math.max(0, Math.min(m, this.total))), a = this.path[i], b = this.path[i + 1];
    const span = this.cum[i + 1] - this.cum[i], t = span > 0 ? Math.min(1, Math.max(0, (m - this.cum[i]) / span)) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // The nearest spot on the route between metres from and to, among stretches running within `angle` of heading
  // (any, without one): { p, d, m, heading }, or null.
  nearest(p, from, to, heading = null, angle = 180) {
    let best = null;
    const i0 = indexAt(this.cum, Math.max(0, from)), i1 = Math.min(this.path.length - 1, indexAt(this.cum, Math.max(0, to)) + 1);
    for (let i = i0; i < i1; i++) {
      if (this.cum[i + 1] === this.cum[i]) continue;
      const a = this.path[i], b = this.path[i + 1], s = onSegment(a, b, p);
      if (best && s.d >= best.d) continue;
      const hd = bearing(a, b);
      if (heading != null && Math.abs(relAngle(hd, heading)) > angle) continue;
      best = { p: s.p, d: s.d, m: this.cum[i] + (this.cum[i + 1] - this.cum[i]) * s.t, heading: hd };
    }
    return best;
  }

  // Where a fix { p, heading, speed (m/s), accuracy (m) } puts you. jumped: metres skipped ahead by this fix.
  update({ p, heading = null, speed = 0, accuracy = 0 }) {
    const moving = heading != null && speed > NAV.movingMps;
    const tol = NAV.onM + Math.min(NAV.slackM, accuracy || 0);
    const ahead = moving ? Math.max(NAV.aheadM, speed * 60) : NAV.stoppedAheadM;
    const near = this.nearest(p, this.m - NAV.backM, this.m + ahead, moving ? heading : null, 90);
    this.jumped = 0;
    if (near && near.d <= tol) return this.take(near);
    // Back on it further along (a part skipped): wherever you're right on it, going its way. Not the last stretch of
    // a loop before you're halfway round: that's where it started, so it's where you are at the start.
    if (moving) {
      const to = this.loop && this.m < this.total / 2 ? this.total - NAV.finishM : this.total;
      const there = this.nearest(p, this.m + ahead, to, heading, NAV.rejoinAngle);
      if (there && there.d <= NAV.rejoinM) {
        this.jumped = there.m - this.m;
        return this.take(there);
      }
    }
    this.d = near ? near.d : Infinity;
    this.spot = null;
    if (++this.offFixes >= NAV.offFixes) this.on = false;
    return this;
  }

  take(s) {
    Object.assign(this, { m: s.m, d: s.d, spot: s, on: true, offFixes: 0 });
    return this;
  }
}

// Where to get back on the ride from p, having left it at metres `from`: the spot quickest to reach counting what it
// skips, at least NAV.skipM past `from` so it never sends you back to where you left (or to a stop you passed by). A
// spot behind you (a U-turn) costs more. { m, p }.
export function rejoinTarget(track, p, heading, from) {
  let best = null;
  for (let m = Math.min(track.total, from + NAV.skipM); m <= track.total; m += NAV.stepM) {
    const q = track.pointAt(m);
    const behind = heading != null && Math.abs(relAngle(bearing(p, q), heading)) > 100;
    const cost = flat(p, q) + NAV.sooner * (m - from) + (behind ? NAV.behindM : 0);
    if (!best || cost < best.cost) best = { m, p: q, cost };
  }
  return best && { m: best.m, p: best.p };
}

// Valhalla maneuver types: leaving a stop (each leg starts with one, "head north on…"), arriving at one, and ones that
// aren't a turn ("becomes", "continue", "stay straight", leaving a roundabout).
const DEPART = new Set([1, 2, 3]), ARRIVE = new Set([4, 5, 6]), QUIET = new Set([0, 7, 8, 22, 27]);

// How far the path turns at index i, in degrees (right positive), over about 25 m either side.
function turnAngle(path, cum, i) {
  let a = i, b = i;
  while (a > 0 && cum[i] - cum[a] < 25) a--;
  while (b < path.length - 1 && cum[b] - cum[i] < 25) b++;
  if (a === i || b === i) return 0;
  return relAngle(bearing(path[i], path[b]), bearing(path[a], path[i]));
}

// The turns to call out on a route, in order: { m (metres along), type, names, text, alert, pre }. Leaving a stop counts
// when the road turns there; arriving only at the very end (with `last`; a way back onto the ride arrives on it).
export function turnsOf(route, last = true) {
  const path = route.path, cum = cumulative(path), ms = route.maneuvers || [], out = [];
  ms.forEach((x, k) => {
    let t = x;
    if (ARRIVE.has(x.type)) {
      if (!last || k < ms.length - 1) return;
    } else if (DEPART.has(x.type)) {
      if (!x.at) return;  // the start
      const angle = turnAngle(path, cum, x.at), name = (x.names || [])[0];
      if (Math.abs(angle) < 35) return;  // straight on past a stop
      const u = Math.abs(angle) > 150, dir = angle > 0 ? 'right' : 'left';
      const text = u ? 'Make a U-turn' : `Turn ${dir}${name ? ` onto ${name}` : ''}`;
      t = { ...x, type: u ? (angle > 0 ? 12 : 13) : angle > 0 ? 10 : 15, text, alert: text, pre: text + '.' };
    } else if (QUIET.has(x.type)) return;
    const m = cum[Math.min(t.at, cum.length - 1)];
    if (out.length && m - out[out.length - 1].m < 5) return;  // two calls for one spot
    out.push({ ...t, m });
  });
  return out;
}

// A distance said out loud: "500 feet", "a quarter mile", "half a mile", "3 miles".
export function spoken(m) {
  const mi = m / 1609.34;
  if (mi < 0.18) return `${Math.max(100, Math.round(m * 3.281 / 100) * 100)} feet`;
  if (mi < 0.375) return 'a quarter mile';
  if (mi < 0.625) return 'half a mile';
  if (mi < 0.875) return 'three quarters of a mile';
  if (mi < 1.25) return '1 mile';
  return `${mi < 5 ? Math.round(mi * 2) / 2 : Math.round(mi)} miles`;
}

// A distance on screen: "350 ft", "0.4 mi", "12 mi".
export function shown(m) {
  const ft = m * 3.281;
  if (ft < 1000) return `${Math.max(0, Math.round(ft / 50) * 50)} ft`;
  return `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
}

const lowerFirst = s => s ? s[0].toLowerCase() + s.slice(1) : s;

// The recorded clips for a turn (voice/phrases.json): what to do, and which exit off a roundabout; and for a heads-up
// distance (they come between about 500 feet and a mile out).
const ACTION = { 9: 'bearright', 10: 'right', 11: 'sharpright', 12: 'uturn', 13: 'uturn', 14: 'sharpleft', 15: 'left', 16: 'bearleft',
  17: 'ramp', 18: 'rampright', 19: 'rampleft', 20: 'exitright', 21: 'exitleft', 23: 'keepright', 24: 'keepleft',
  25: 'merge', 37: 'merge', 38: 'merge', 26: 'roundabout', 28: 'ferry' };
export function turnClips(turn) {
  const a = ACTION[turn.type] || 'continue';
  return a === 'roundabout' && turn.exit >= 1 && turn.exit <= 4 ? [a, `exit${turn.exit}`] : [a];
}
export function distanceClip(m) {
  const mi = m / 1609.34;
  return mi < 0.18 ? 'd500ft' : mi < 0.375 ? 'dquarter' : mi < 0.625 ? 'dhalf' : mi < 0.875 ? 'd3quarter' : 'd1';
}

// What to say about a turn inM ahead at speed (m/s): a heads-up a way off ("In half a mile, turn right onto MO D"),
// then the call as it comes up, each once (marked on the turn). { text, clips } (the words for the phone's voice, the
// recorded clips otherwise), or null. Not the arrival: the end of the ride says that.
export function callout(turn, inM, speed) {
  if (ARRIVE.has(turn.type)) return null;
  const v = Math.max(speed || 0, 8);
  const callM = Math.max(NAV.callM, v * NAV.callS), headsUpM = Math.max(NAV.headsUpM, v * NAV.headsUpS);
  if (inM <= callM) {
    if (turn.said === 'call') return null;
    turn.said = 'call';
    return { text: turn.pre || turn.text, clips: turnClips(turn) };
  }
  if (inM <= headsUpM && inM > callM * 1.6 && !turn.said) {
    turn.said = 'heads-up';
    return { text: `In ${spoken(inM)}, ${lowerFirst((turn.alert || turn.text).replace(/\.$/, ''))}.`, clips: [distanceClip(inM), ...turnClips(turn)] };
  }
  return null;
}

// Riding a route: the ride itself (main), and while you're off it, the way back on (a detour from
// reroute(p, heading, target) → route or null, asked for as you go). fix() returns what just happened, if anything:
// 'back' (on the ride again), 'skipped' (back on it further along), 'off', 'done'. onDetour() runs when a way back
// arrives.
export class Guide {
  constructor(route, { reroute, onDetour = () => {}, now = () => Date.now() }) {
    this.route = route;
    this.main = new Track(route.path);
    this.turns = turnsOf(route);
    this.reroute = reroute;
    this.onDetour = onDetour;
    this.now = now;
    this.detour = null;   // { route, track, turns, target }
    this.target = null;   // where on the ride the way back goes to
    this.asking = null;   // the reroute being asked for
    this.asked = null;    // { t, p } of the last ask
    this.skipFrom = 0;    // Skip ahead: rejoin past this
    this.done = false;
  }

  get state() { return this.done ? 'done' : this.main.on !== false ? 'on' : this.detour ? 'detour' : 'off'; }

  fix(f) {
    if (this.done) return null;
    this.last = f;
    const was = this.state, main = this.main.update(f);
    let event = null;
    if (main.on) {
      this.detour = null;
      if (was === 'off' || was === 'detour') event = main.jumped > NAV.skipM ? 'skipped' : 'back';
      else if (main.jumped > NAV.skipM) event = 'skipped';
      if (main.m >= main.total - NAV.arriveM && main.m > NAV.arriveM) {
        this.done = true;
        event = 'done';
      }
      return event;
    }
    if (main.on !== false) return null;  // not sure yet
    if (this.detour && this.detour.track.update(f).on === false) this.detour = null;  // off the way back too
    if (!this.detour) this.askWayBack(f);
    return was === 'on' ? 'off' : null;
  }

  askWayBack(f) {
    if (this.asking) return;
    const t = this.now();
    if (this.asked) {
      const since = (t - this.asked.t) / 1000, moved = flat(this.asked.p, f.p);
      if (since < NAV.rerouteS || (moved < NAV.rerouteMovedM && since < 4 * NAV.rerouteS)) return;
    }
    const target = rejoinTarget(this.main, f.p, f.heading, Math.max(this.main.m, this.skipFrom));
    if (!target) return;
    this.target = target;
    this.asked = { t, p: f.p };
    const heading = this.main.nearest(target.p, target.m - 1, target.m + 30)?.heading ?? null;
    this.asking = Promise.resolve(this.reroute(f.p, f.heading, { ...target, heading })).catch(() => null).then(r => {
      this.asking = null;
      if (!r || this.main.on !== false || this.detour) return;
      this.detour = { route: r, track: new Track(r.path), turns: turnsOf(r, false), target };
      this.detour.track.update(this.last);
      this.onDetour();
    });
  }

  // Skip ahead while off the ride: get back on it further along than the way back went.
  skip() {
    this.skipFrom = (this.target ? this.target.m : this.main.m) + NAV.skipAheadM;
    this.detour = null;
    this.asked = null;
    if (this.last) this.askWayBack(this.last);
  }

  // The track and turns being followed now: the way back while there is one, else the ride.
  get leg() { return this.state === 'detour' ? this.detour : { track: this.main, turns: this.turns }; }

  // The next turns from where you are on the leg being followed (the turn, and metres to it).
  upcoming(n = 2) {
    const { track, turns } = this.leg;
    return turns.filter(x => x.m > track.m + 3).slice(0, n).map(turn => ({ turn, inM: turn.m - track.m }));
  }

  // Metres left to ride: the way back, then the ride from where it rejoins.
  get leftM() {
    if (this.state === 'detour') return this.detour.track.total - this.detour.track.m + this.main.total - this.detour.target.m;
    return Math.max(0, this.main.total - this.main.m);
  }
}
