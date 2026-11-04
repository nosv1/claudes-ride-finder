// End-to-end locking for what the account service keeps: rides, their names, settings, tags and share links are locked
// (AES-GCM) in the browser before they're sent, so the service, and whoever runs it, only ever holds what it can't read.
// A locked value is base64url text: 12 bytes of IV, then the ciphertext.
//
// Two kinds of key:
// - An account key (32 random bytes), made on the first device and kept on each device the rider adds (the "add a
//   device" link carries it after the #, which browsers never send anywhere). The service keeps only its id, a hash.
// - A share link's code (12 random bytes, 16 characters): the link is #s=<code>. The service is told only a hash of
//   the code to look the ride up by; the key that unlocks it comes from the code by a different hash, so the service
//   can't get from one to the other.

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hash = async (label, bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode(label), ...bytes])));
const aes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export const newAccountKey = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const keyId = async key => b64(await hash('rf-account-key-id', unb64(key))).slice(0, 16);

export async function lock(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(unb64(key)), enc.encode(text));
  return b64([...iv, ...new Uint8Array(ct)]);
}

// The text, or null if it doesn't unlock with this key (a wrong key, or something saved before locking existed).
export async function unlock(key, locked) {
  try {
    const bytes = unb64(locked);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aes(unb64(key)), bytes.slice(12));
    return dec.decode(pt);
  } catch (e) {
    return null;
  }
}

// A new share link's code, and from any code the id the service looks it up by and the key that unlocks it.
export const newLinkCode = () => b64(crypto.getRandomValues(new Uint8Array(12)));
export async function linkParts(code) {
  const raw = unb64(code);
  return { id: b64(await hash('rf-link-id', raw)).slice(0, 16), key: b64(await hash('rf-link-key', raw)) };
}
