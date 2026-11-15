# asda-trip

A [Scriptable](https://scriptable.app) home-screen widget for the drive from RM8 2YX to Asda Beckton.

- **Saturday 18:00–21:00 (London time):** live trip panel – drive time, arrival time, A13 status and incidents on the route.
- **Any other time:** one button that opens the route in Google Maps.

## Install

1. In Scriptable, create a new script called `Asda Trip` and paste in the contents of [`AsdaTrip.js`](AsdaTrip.js).
2. Add a **medium** Scriptable widget to the home screen (small also works), long-press → Edit Widget → Script: `Asda Trip`.
3. Optional but recommended: get a free key at [developer.tomtom.com](https://developer.tomtom.com) and paste it into `TOMTOM_KEY` at the top of the script. With it the widget shows a real live-traffic drive time; without it, it shows TfL's A13 status and incidents next to the typical time (marked `~`).

To preview the live panel outside the Saturday window, set `forceLive: true` and run the script in the app.

## Notes

- Tapping the widget opens the route in Google Maps. **Reverse** flips the direction (it briefly opens Scriptable, which is how widget buttons work) and resets itself after 6 hours.
- If a data source is down, the widget falls back to the last result (up to 20 minutes old, with its timestamp shown) and always keeps the Maps link.
- iOS decides how often widgets refresh; the script asks for every 3 minutes during the window and for a refresh exactly when the window opens and closes.
