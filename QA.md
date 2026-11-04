# QA checks

Run through this before calling a change done, on a desktop browser and on a phone (or the phone-sized
window). Each check is: do this → you should see that. ✱ marks checks that come from something a rider
actually hit.

The automated tests (`node --test tests/app/*.test.mjs`, with `RF_NETWORK=1` for routing) cover a lot of this,
but not what it feels like to use. These checks are for that.

## Everything on the map can be tapped

- ✱ Every kind of thing drawn on the map does something when tapped: colored roads (card), uncolored roads and
  the route line (speed tag), stop markers (the ride), gas stations (card), the search pin (place card).
  Blind-crest signs and stoplight icons act like the road they're on. Nothing should look tappable and do nothing.
- ✱ Things of the same kind offer the same actions. A searched place gets Add to ride / Start here / End here
  like a road or gas station does.
- ✱ Feedback shows up near the finger, not at the far edge of the screen (the speed tag at the tap).
- A tap on empty map closes the open card and nothing else.
- Long-press (phone) and right-click (desktop) open the spot menu with Start / End / Add a stop / Street View.

## Search

- ✱ Picking a result puts its name in the search box.
- ✱ A place result drops a pin and opens its card; tapping the pin again reopens the card.
- A road result ("hwy 7") zooms to the road and opens its card with Add to ride.
- The ✕ clears the box, the pin and the place card.
- Enter picks the first result; Esc closes the list.
- A town outside KS / MO / TX still comes up (online results).

## Speed limits

- ✱ Tapping MO 7, an interstate, and a side street each show a tag at the tap with a limit, at zoom 10 to 16.
- ✱ The first tap in a new area says "Checking the speed limit…" and then answers (no silent wait).
- Tapping a colored road shows its speed tag and opens its card.
- The tag goes away on its own after about 5 seconds, and when a fly-through starts.

## Generating loops

For each of 1 h, 1½ h, 3 h and 6 h, from Lee's Summit and from somewhere rural:

- ✱ No loop shown rides more than about a fifth of the way twice when there are cleaner ones. Orange dashes on
  the map show what's ridden twice; check they're on the map where the card says.
- ✱ Loops don't go out and back on the same highway to reach the curvy part.
- Loops come in near the chosen time (80–120%), and the cards say how long.
- There's a loop to each side of the start where there are good roads, and a note says which sides have none.
- The status line keeps moving while it works; a 6 h run finishes in under about 3 minutes.
- Tapping a card loads it; "Ride this loop →" opens the ride with the stops in order.

## One way

- Setting an end (Pick on map, End here on a place, or End a ride here) switches Plan a ride to One way.
- The ways there all finish at the end, not back at the start, and come in near the straight-way time plus the
  extra chosen.
- Adding a stop to a one-way ride puts it before the end, never after.
- Switching back to Loop generates loops again.

## Stoplights

- ✱ The 🚦 count on a card matches the icons on the route when that loop is shown.
- ✱ Lights marked as a left turn (orange ring) really are turns: look at a few on the map. A straight run
  through a light is not a left.
- A highway passing over a cross street with a light doesn't count that light.

## The ride

- Stops can be dragged into a new order (mouse and touch), removed, and Clear all can be undone.
- "Try fixing" on a ride that doubles back either helps or says why not.
- Fuel stops are planned within the tank range.
- Go opens Google Maps with the stops in order; GPX downloads; Share gives a link that reopens the same ride,
  including a one-way ride's end.
- Reloading the page keeps the ride and the settings.
- The fly-through plays, shows the road sign, speed limit and next turn, and Esc / ✕ ends it.

## Looks and layout

- Nothing wraps awkwardly or gets cut off in the side panel (buttons, chips, card text), on desktop or phone.
- Satellite and dark map both readable; route, icons and tags visible on both.
- 3D tilt works and flat returns to north-up.

## Data

- After a data rebuild: the map loads around KC, Austin and the Ozarks, and `tiles/signals.js` exists.
- The live site (after a merge to `main`) shows the change within a minute; a hard refresh isn't needed.
