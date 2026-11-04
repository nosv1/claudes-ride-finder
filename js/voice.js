// Ride mode's voice: which one and how fast (kept on this device: every phone has its own voices), and speaking so
// music playing in another app dips under it rather than stopping, where the phone allows it.
const KEY = 'rf2-voice-pick';
export const SAMPLE = 'In half a mile, turn right onto Missouri D.';
export const RATES = [['0.85', 'Slower'], ['1', 'Normal'], ['1.15', 'Faster']];

export function voicePick() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
}
export function setVoicePick(pick) {
  try { localStorage.setItem(KEY, JSON.stringify(pick)); } catch (e) { /* storage unavailable */ }
}

// The phone's English voices, the better-sounding ones (Premium, Enhanced, Natural) first, then US ones.
export function voices() {
  const all = globalThis.speechSynthesis ? speechSynthesis.getVoices() : [];
  const rank = v => (/premium|enhanced|natural|neural/i.test(v.name) ? 0 : 2) + (v.lang === 'en-US' ? 0 : 1);
  return all.filter(v => /^en/i.test(v.lang)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function speak(text, pick = voicePick()) {
  if (!text || !globalThis.speechSynthesis) return;
  // Safari's audio session: a "transient" sound plays over other apps' audio, turning it down for a moment, instead of
  // taking over (which pauses the music for good). Phones without it do what they do.
  try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch (e) { /* not supported */ }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text), v = pick.uri && speechSynthesis.getVoices().find(x => x.voiceURI === pick.uri);
  if (v) u.voice = v;
  u.lang = v ? v.lang : 'en-US';
  u.rate = +pick.rate || 1;
  speechSynthesis.speak(u);
}
