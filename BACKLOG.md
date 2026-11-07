# Backlog

Ideas that came up, roughly in order of how much they'd help.

- **Esri basemap: keyless or keyed?** (the one open part of Ready to share; the About page, link preview, busy
  message and Install button are done). Checked 2026-11-04: the `server.arcgisonline.com` tiles load without a key,
  but no published Esri terms clearly allow keyless use in a public app. Esri forum answers say the keyless basemaps
  need an ArcGIS subscription or license; nothing official says otherwise. The keyed route is ArcGIS Location Platform's
  free tier: 2,000,000 basemap tiles a month free, then $0.15 per 1,000 (Esri's numbers; they say these change, so
  check location.arcgis.com/pricing). It needs an account and an API key in `js/mapview.js` (a key in a public site
  is normal for Esri; restrict it to the site's address). A key-free alternative is OpenFreeMap's vector styles
  (already used for the fonts), but they look different and have no satellite. Fine to leave as is while it's a
  handful of friends.
- **Accounts, what's left** (accounts shipped 2026-11-04: see FEATURES.md, Accounts). Sign in with Apple needs the
  $99/yr developer account, so it waits for the iPhone app. Saved rides edited on two devices at once: the last save
  wins (fine for one rider; a merge would be needed for sharing a ride to plan together). The Google consent screen
  has no logo on purpose: adding one means Google reviews the app first. A ride edited on one device while another
  has it open: the other's list updates when it comes back to the app, but the stops on its screen only change when
  the ride is opened again. Not yet confirmed by the rider (2026-11-06): a real Google sign-in on the live site, and
  adding the phone with the device link (the tests use made-up sign-ins against a local copy of the API).
- **A proper app, still on PC**: one codebase for all three. Android: wrap the web app for the Play Store
  (Trusted Web Activity via Bubblewrap; $25 once). iPhone: Capacitor wrapper ($99/yr developer account,
  built on a Mac or a cloud build). PC keeps using the website or the installed web app. Worth it mainly for
  Ride mode: a native app can keep GPS and voice going with the screen off, which a browser can't.
- **Bottlenecks to fix before going national** (measured 2026-11-01): the site's map files are 68 MB for
  3 states (about 70% is the speed-limit layer), so the whole US would be near GitHub Pages' 1 GB limit,
  and every rebuild adds to git history. Slim the speed-limit layer, then move tiles off git (e.g.
  Cloudflare R2).
- **Our own router, once other people use the site**: routing runs on the free public Valhalla server
  (FOSSGIS), which has no key and no published limit, only fair use. One Generate sends about 40 requests
  for 1½ h and about 150 for 6 h (checked 2026-11-03). It already slows each request down when two are sent at
  once, so a handful of riders generating at once could get the site throttled or blocked. The OSRM demo
  fallback is 1 request a second and not meant for apps. Options: run Valhalla ourselves (Docker, built
  from the same `.osm.pbf` files in `raw/`, on the PC or a small cloud server), or a hosted Valhalla with
  a free tier (Stadia Maps; check its current limits and price). Either way, keep the motorcycle costing
  and point `valhalla` in `js/config.js` at it. Photon search and Open-Meteo weather are fine for a group
  of riders as they are.
- **Speed limits next** (Your limit and Edit in OpenStreetMap went in 2026-11-06, for NE Strother Rd, SW Scherer Rd and
  Raytown Rd near Lee's Summit, all missing from Best rides at 45+):
  - (Done 2026-11-06: the better town guess, an edge-of-town 45 when few streets meet a road; FEATURES.md.)
  - **Raytown Rd as a sweeper**: each piece has 300–500 m of sweep (~1.9 km over the whole road) but is under the
    sweeper bar alone. Score sweep across a named stretch, not per piece (`isSweeper` in `js/roads.js`; sum in
    `summarize` or in the build).
  - **Hidden-road hint**: in Best rides, show roads hidden only by a guessed limit faintly, so they can be tapped and
    given Your limit without switching to All curvy roads.
  - OSM fixes by the rider reach the app after Geofabrik's next daily extract and a rebuild (fresh `.osm.pbf` in
    `raw/`, `python build_tiles.py`, bump, commit `tiles/`). A posted `maxspeed` replaces the guess.
- **Natural voice: put the road names live** (Helena and Apollo, Aura-2, are recorded and the default since
  2026-11-06; the app asks for road names already). Needs the accounts Worker deployed with `/speak` (it was blocked
  as a production deploy, so the rider runs it or OKs it): `cd worker`, then
  `npx wrangler@4 d1 execute ride-finder --remote --command "CREATE TABLE IF NOT EXISTS clips (voice TEXT NOT NULL, format TEXT NOT NULL, text TEXT NOT NULL, audio BLOB NOT NULL, made INTEGER NOT NULL, PRIMARY KEY (voice, format, text));"`
  and `npx wrangler@4 deploy`. Until then the names are just left out. More voices: add them to `make_voice.py` and
  `python tools/make_voice.py <id>` (~730 characters of the day's free allowance each; Thalia was next).
- **Ride mode next** (Ride mode is in, 2026-11-04): gas callouts ("Casey's in 4 mi, next gas 38 mi"), the ridden track
  saved (for Roads you've ridden), Valhalla avoiding roads tagged Don't ride between stops (`exclude_polygons` or
  `avoid_locations`), and screen-off guidance, which needs a native app (see the Play Store / iPhone entry).
- **Road tags with others**: tags are on the device now. With accounts (below), sync them across your devices, and
  maybe let riders share them ("12 riders say rough") so a bad road warns everyone.
- **Weather layer: ride or not, at a glance**. Not a weather app: only what decides a ride (wet roads, storms,
  wind, cold), shown on the map before there's a ride to plan. The ride weather already comes from Open-Meteo for
  points along a route; the layer (in the layers menu, off by default) would show the same over the whole map.
  - **Forecast at your leave time**: Open-Meteo takes many points in one request (the ride weather already does),
    so a coarse grid over the view (about every 25 km) gives rain chance, storms and gusts for any hour of the next
    7 days. Shade rain chance, mark storms, and let the Leaving time pick the hour. Open-Meteo counts each point as a
    request (free up to about 10,000 a day, non-commercial), so fetch only when the map moves well away, and reuse
    grid cells already loaded.
  - **Radar for right now**: live radar tiles with the last hour or two looping, for "is it raining out there and
    which way is it moving". RainViewer has free radar tiles (it cut back its free use in 2025; check what's left
    and the credit it wants). Only now, not later, so it goes with the forecast, not instead of it.
  - **One line on top** that answers the question: "Dry until 4 pm, gusts 30 after 2", for the area in view at the
    leave time.
  - With a ride, color its line by the rain chance when you'd pass (that data is already there).
- **Fly-through extras**: a chase camera that banks into corners; a "skip the boring parts" toggle that
  speeds through highways and town; curve callouts ("Tight curves next 2.1 mi", hairpins); gas stops as you
  pass them ("Casey's, 90+ likely, next gas 38 mi"); recording it as a video to share.
- **Interchange tours and roundabouts**: fast ramps and highway sweeps now show with the Highways road type.
  Roundabouts drawn as one closed way are now left off the curvy map; ones split into pieces still show as
  short Twisty arcs. Keep `junction=roundabout` in `build_tiles.py` to catch them all (and to map them).
  Next: roundabouts (`junction=roundabout`, like the double roundabouts on 87th St), and a
  generator for short interchange loops, e.g. west on I-470, US-71 north, I-435 north, the
  87th St roundabouts, and back through the Grandview Triangle.
- **Mixed rides: back roads plus interchanges**: a good loop can link curvy back roads with fun
  interchanges, as long as the highway parts sweep and aren't jammed.
  - **Highway sweeps**: done (Highways road type and All roads, 65+ mph, bonus for 3+ lanes). Two-lane trunk highways at
    65 (US 83 in western Kansas) aren't curvy candidates at all yet; scoring them as ordinary roads would add
    their sweepers to Best rides.
  - **Generator**: done for highway sweeps (candidates unless Back roads; sweep and fast-ramp miles count in a
    ride's score). Next: fast ramps as stops too, and routing between roads through the best interchanges
    instead of only the fastest or flattest way.
  - **Low traffic**: suggest when to go, since a fun interchange in rush hour isn't. Simplest is a rule of
    thumb (weekend mornings, weekdays outside 6–9 am and 3–7 pm). Better is typical traffic by hour, if a free
    source turns up (state DOT counts, e.g. KDOT and MoDOT, give daily volume per segment, not by hour). Put
    it on the leave-time picker: "I-435 is usually quiet now".
    TomTom's free tier looks like enough for one rider (checked 2026-11-03, from third-party price lists; TomTom
    reportedly changed pricing in July 2026, so confirm): ~50,000 map tiles a day covers a live traffic-flow
    overlay, and ~2,500 other requests a day covers expected traffic, by routing the highway parts with the
    leave time and comparing against the empty-road time. Google (~$10 per 1,000 after 5,000 a month) and HERE
    cost more; Mapbox traffic is quote-only. KC Scout has the I-435 sensors but no public feed found.
- **Hide maybe-gravel roads**: an option to hide county roads whose surface isn't recorded
  (drawn dashed today). Many are gravel in the Ozarks.
- **Generator avoids city traffic**: today loops through town only rank lower. Penalize
  connecting routes through built-up areas directly.
- **Roller coasters, next**: blind crests on straight roads (a hilltop you can't see over, no turn needed).
- **More states**: Arkansas (Eureka Springs, the Pig Trail), Oklahoma, Iowa, Nebraska. (Texas is in.)
  Check each state's default speed limits in `estimate_mph`.
  Download the `.osm.pbf` into `raw/` and rebuild.
- **Cameras layer: plate readers, speed and red-light cameras**: a map layer (off by default, like Gas) and a
  count on each ride, the way stoplights are counted. Plate readers (Flock Safety and others) are mapped in OSM as
  `man_made=surveillance` with `surveillance:type=ALPR` (plus `manufacturer`, `direction`), mostly by the DeFlock
  project; speed cameras as `highway=speed_camera`; red-light cameras as `enforcement` relations or
  `highway=traffic_signals` + `enforcement=traffic_signals`. All nodes, so `tools/add_signals.py`'s nodes-only pass can
  collect them too, into their own file. Show which way a camera faces when mapped. Coverage is whatever volunteers
  have mapped, so say so ("mapped cameras", not "all cameras").
- **Sunset and deer hour**: warn when a ride ends after dark (Open-Meteo has sunset), and flag dusk on
  wooded back roads, when deer are out. Shown with the weather.
- **Roads you've ridden**: import GPX from a ride (or record one in Ride mode) and mark those roads, so
  the map shows what's new to you and the generator can prefer it.
- **Adventures (make it a game)**: a reason to go ride, as "go see this, by these roads".
  - **Destinations**: add places worth riding to from OSM in `build_tiles.py`, kept like `fuel.js`:
    viewpoints, waterfalls, peaks, historic sites, river crossings and ferries, old bridges, small-town diners
    and BBQ. Prefer ones off the beaten path, with good curvy roads nearby.
  - **Quests**: the generator picks a destination for the time you have, rides out on curvy roads and back on
    different ones. The card reads like a mission ("Reach Elephant Rocks by the curvy part of MO-21,
    3 h, 2 blind crests") and the fly-through plays as the briefing.
  - **Collections**: sets to finish, like every Flyover in KC, the Twisted Sisters, all lettered routes in
    a county, every Ozark river crossing, or the I-435 loop at dawn. Badges for the firsts (first 100 curvy miles,
    first very hilly road, first state line crossed).
  - **Map that fills in**: roads you've ridden glow and the rest stay dim, so new roads stand out
    (needs Roads you've ridden).
  - **Ride of the week**: one quest near you each week, the same for everyone in the area, so friends can
    ride the same one.
  - **Proof**: a quest counts as done when a GPX import (or Ride mode track) covers most of its roads.
    Kept on the device, no account.
  - **No speed or time scores.** Score roads and places, never how fast you got there: leaderboards for
    pace on public roads are how people get hurt (and how the app gets blamed).
- **Saved rides**: keep rides by name on the device (not just the last one), with the share link.
- **Saved places** (the rider, 2026-11-06): keep stops like Home and Work by name, and offer them first wherever a
  start, end or stop is picked (search box, the map's menu, Generate's start), so "loop from home" or "ride home from
  work the long way" is one tap. Kept with the account and locked like rides (`js/seal.js`): home is the most private
  thing the app would hold.
- **Group rides**: a share link with the leave time and meeting spot, so everyone sees the same plan.
- **Dead-end roads in the generator**: lake roads in the Ozarks often dead-end at the water, so a
  loop rides them out and back. The generator now drops them after routing; marking dead ends in
  `build_tiles.py` would skip them up front (and save routing requests).
