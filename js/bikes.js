// Your bikes: typed in by you on the account page, kept in settings (so every device has them). Each is
// { id, name, gal, mpg, octane, tankMiles }: its tank and mpg make its range on a full tank, octane is the least it
// takes (a number), and tankMiles is how far it's gone
// since filling up (its trip meter), carried from ride to ride. settings.defaultBike is the one a ride uses unless the
// ride picks another (trip.bikeId).

export const newBikeId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const complete = b => !!b && b.gal > 0 && b.mpg > 0;
export const rangeOf = b => complete(b) ? Math.round(b.gal * b.mpg) : null;
export const OCTANES = [85, 87, 88, 89, 90, 91, 92, 93, 94];
export const octaneOf = b => (b && +b.octane) || 87;
export const leftIn = b => complete(b) ? Math.max(0, rangeOf(b) - Math.max(0, +b.tankMiles || 0)) : null;

// The bike for a ride: the ride's own pick, else your default, else your first.
export function bikeFor(settings, trip) {
  const list = settings.bikes || [];
  return list.find(b => b.id === (trip && trip.bikeId)) || list.find(b => b.id === settings.defaultBike) || list[0] || null;
}

// Settings from before the list (11 Nov 2026: one picked bike, `bike: { id, gal, mpg }`, and `tankMiles`) become a
// list of one, the default. Returns the settings, changed in place.
export function upgradeBikes(s) {
  if (!s.bikes && s.bike && s.bike.gal > 0) {
    const b = { id: newBikeId(), name: s.bike.id === 'gsxr750' ? 'Suzuki GSX-R750' : 'My bike', gal: s.bike.gal, mpg: s.bike.mpg,
      tankMiles: Math.max(0, +s.tankMiles || 0) };
    s.bikes = [b];
    s.defaultBike = b.id;
  }
  delete s.bike;
  delete s.tankMiles;
  // A named grade (2026.11.11.16) becomes its number.
  for (const b of s.bikes || []) {
    if (b.fuel) { b.octane = b.octane || { regular: 87, mid: 89, premium: 91 }[b.fuel] || 87; delete b.fuel; }
  }
  return s;
}
