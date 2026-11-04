// Ride mode's voice. Recorded clips (voice/<id>/<clip>, made by tools/make_voice.py from voice/phrases.json) by default:
// on iPhone an audio file plays over music in another app, while the phone's own voice stops it for good (found with
// sound-check.html). The phone's voices can be picked instead: they say road names, but stop the music. The pick and
// its speed are kept on this device (every phone has its own voices).
const KEY = 'rf2-voice-pick';
export const SAMPLE = { text: 'In half a mile, turn right onto Missouri D.', clips: ['dhalf', 'right'] };
export const RATES = [['0.85', 'Slower'], ['1', 'Normal'], ['1.15', 'Faster']];
export const log = [];  // the words of each thing said (for tests)

let library = [];  // the recorded voices, [{ id, label, ext, chime }], from voice/voices.json
const CHIME = 'voice/chime.wav';
export const loadVoices = () => fetch('voice/voices.json').then(r => r.json()).then(list => { library = list; return list; }).catch(() => []);
export const recorded = () => library;

// { id } a recorded voice, or { phone: true, uri } one of the phone's ('' its default); and rate. Nothing picked (or
// a recorded voice that's gone): the first recorded voice.
export function voicePick() {
  let pick = {};
  try { pick = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { /* none */ }
  return pick.phone || library.some(v => v.id === pick.id) ? pick : { ...pick, id: library[0] && library[0].id };
}
export function setVoicePick(pick) {
  try { localStorage.setItem(KEY, JSON.stringify(pick)); } catch (e) { /* storage unavailable */ }
}

// The phone's English voices, the better-sounding ones (Premium, Enhanced, Natural) first, then US ones.
export function phoneVoices() {
  const all = globalThis.speechSynthesis ? speechSynthesis.getVoices() : [];
  const rank = v => (/premium|enhanced|natural|neural/i.test(v.name) ? 0 : 2) + (v.lang === 'en-US' ? 0 : 1);
  return all.filter(v => /^en/i.test(v.lang)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// Safari's audio session: "transient" lets an audio file play over other apps' audio (the default stops it).
function mixIn() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch (e) { /* not supported */ }
}

// One player for every clip: an iPhone lets a page play sound only after a tap has played it once (Ride mode's
// start does), then from then on. A phrase is a few clips played one after another.
const player = typeof Audio === 'function' ? new Audio() : null;
let queue = [];
const loaded = new Map();  // clip URL → the clip in memory (preload): plays with no signal, and no partial loads
export const clipsLoaded = () => loaded.size;
const next = () => {
  const src = queue.shift();
  if (!src) return;
  player.src = src;
  player.play().catch(() => { queue = []; });
};
if (player) player.addEventListener('ended', next);

// Say a phrase { text, clips }: the clips in the picked recorded voice, else the text in the phone's voice.
export function speak(phrase, pick = voicePick()) {
  if (!phrase) return;
  log.push(phrase.text);
  mixIn();
  const v = !pick.phone && phrase.clips && player && library.find(x => x.id === pick.id);
  if (v) {
    if (globalThis.speechSynthesis) speechSynthesis.cancel();
    // A robotic voice (chime) beeps first: a robot calling in, not one trying to sound like a person.
    queue = [...(v.chime ? [CHIME] : []), ...phrase.clips.map(k => `voice/${v.id}/${k}.${v.ext}`)].map(u => loaded.get(u) || u);
    player.playbackRate = +pick.rate || 1;
    return next();
  }
  if (!globalThis.speechSynthesis || !phrase.text) return;
  queue = [];
  if (player) player.pause();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(phrase.text), pv = pick.uri && speechSynthesis.getVoices().find(x => x.voiceURI === pick.uri);
  if (pv) u.voice = pv;
  u.lang = pv ? pv.lang : 'en-US';
  u.rate = +pick.rate || 1;
  speechSynthesis.speak(u);
}

export function hush() {
  queue = [];
  if (player) player.pause();
  if (globalThis.speechSynthesis) speechSynthesis.cancel();
}

// Load every clip of the picked voice now, while there's signal, so the ride's calls play without it.
export async function preload(pick = voicePick()) {
  const v = !pick.phone && library.find(x => x.id === pick.id);
  if (!v) return;
  try {
    const keys = Object.keys(await (await fetch('voice/phrases.json')).json());
    const urls = [...(v.chime ? [CHIME] : []), ...keys.map(k => `voice/${v.id}/${k}.${v.ext}`)];
    await Promise.all(urls.map(async url => {
      if (loaded.has(url)) return;
      const res = await fetch(url).catch(() => null);
      if (res && res.ok) loaded.set(url, URL.createObjectURL(await res.blob()));
    }));
  } catch (e) { /* offline: the calls play if they were loaded before */ }
}
