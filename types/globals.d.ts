// What the page has besides the app's own modules, for the type check (npm run check). Not part of the site.

// MapLibre GL, from its script tag in index.html, and Google sign-in (accounts.google.com/gsi/client, loaded by
// account.js when it's needed): typed loosely, as the app uses only a little of each.
declare const maplibregl: any;
declare const google: any;

interface Window {
  // The data files in tiles/ are plain scripts that set these (and call addTile for each road tile).
  TILE_INDEX: any;
  FUEL: any;
  SEARCH: any;
  SIGNALS: any;
  BREAKS: any;
  addTile: (key: string, data: any) => void;
  // For the tests: the app's state, read and driven over the DevTools protocol.
  RF: any;
}

interface Navigator {
  standalone?: boolean;  // iOS Safari: opened from the home screen
  audioSession?: { type: string };  // Safari: lets the voice play over other audio
}
