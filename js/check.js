// Assertions (CODING.md, rule 5). check(ok, what) states something that has to be true for the code after it to be
// right. When it isn't, that's a bug: it's reported ("Check failed: …" on the console, which fails the browser tests),
// and check returns false, so the caller recovers (leaves things as they are, or does nothing) instead of carrying
// on with bad data. It never throws: a rider mid-ride is better off with one thing not done than a stuck app.
export function check(ok, what) {
  if (!ok) console.error(`Check failed: ${what}`);
  return !!ok;
}
