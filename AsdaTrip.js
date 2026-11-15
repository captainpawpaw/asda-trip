// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: shopping-cart;

// Asda Trip – Scriptable widget (medium recommended, small supported)
//
// Saturday 18:00–21:00 (London time): live trip panel.
// Any other time: a single "Open route in Google Maps" button.
//
// Data sources (all official, each one optional – the widget always renders):
//   • TfL Unified API  – A13 corridor status + active incidents (no key needed)
//   • TomTom Routing   – real live-traffic drive time (free key, see TOMTOM_KEY)
//   • postcodes.io     – one-off postcode → coordinates lookup, then cached

// ───────────────────────── Config ─────────────────────────
const CONFIG = {
  home: { label: "RM8 2YX", postcode: "RM8 2YX", maps: "RM8 2YX" },
  shop: {
    label: "Asda Beckton",
    postcode: "E6 5JP",
    maps: "Asda Beckton Superstore, Tollgate Road, London E6 5JP",
  },

  // Live window, in London time. day: 0 = Sunday … 6 = Saturday.
  window: { day: 6, startHour: 18, endHour: 21 },

  // Free key from developer.tomtom.com (no card). Leave "" to run without
  // it: you still get TfL status + incidents, with the typical time below.
  TOMTOM_KEY: "",

  road: "A13", // TfL corridor id
  via: "A13 Alfred's Way",
  typicalMinutes: 16, // shown (marked "typical") when no live ETA
  typicalMiles: 6.1,

  // true = comgooglemaps:// (always the app, does nothing if not installed)
  // false = https link (opens the app if installed, otherwise the website)
  useGoogleMapsAppScheme: false,

  // Set true to preview the live panel outside the Saturday window.
  forceLive: false,
};

// Used for incident filtering if the postcode lookup has never succeeded.
const FALLBACK_BBOX = { minLat: 51.5, maxLat: 51.57, minLon: 0.03, maxLon: 0.17 };

const REFRESH_MINUTES = 3; // requested cadence inside the window (iOS decides)
const STALE_AFTER_MIN = 20; // cached live data older than this is discarded
const DIRECTION_RESET_HOURS = 6; // "Reverse" snaps back to home → shop after this
const TIMEOUT_SECONDS = 8;

const C = {
  bg: new Color("#0b1020"),
  text: Color.white(),
  dim: new Color("#8a93a8"),
  panel: new Color("#1a2033"),
  pill: new Color("#2d3270"),
  link: new Color("#5db4ff"),
  good: new Color("#5fd38d"),
  warn: new Color("#f5b941"),
  bad: new Color("#ff6b6b"),
};

// ───────────────────────── Persistent state ─────────────────────────
const fm = FileManager.local();
const STATE_PATH = fm.joinPath(fm.documentsDirectory(), "asda-trip-state.json");

function loadState() {
  try {
    if (fm.fileExists(STATE_PATH)) return JSON.parse(fm.readString(STATE_PATH)) || {};
  } catch (e) {}
  return {};
}

function saveState(state) {
  try {
    fm.writeString(STATE_PATH, JSON.stringify(state));
  } catch (e) {}
}

// ───────────────────────── Time (always Europe/London) ─────────────────────────
const LONDON_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function londonParts(date) {
  const p = {};
  for (const part of LONDON_FMT.formatToParts(date)) p[part.type] = part.value;
  return { day: DAYS.indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute) };
}

function londonClock(date) {
  const t = londonParts(date);
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

// Minutes until the window opens (0 if open) and until it closes (0 if shut).
function windowInfo(now) {
  const WEEK = 7 * 1440;
  const t = londonParts(now);
  const nowMin = t.day * 1440 + t.hour * 60 + t.minute;
  const start = CONFIG.window.day * 1440 + CONFIG.window.startHour * 60;
  const end = CONFIG.window.day * 1440 + CONFIG.window.endHour * 60;
  const open = nowMin >= start && nowMin < end;
  return {
    open,
    minsToOpen: open ? 0 : (start - nowMin + WEEK) % WEEK,
    minsToClose: open ? end - nowMin : 0,
  };
}

// ───────────────────────── Networking ─────────────────────────
async function getJSON(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const req = new Request(url);
      req.timeoutInterval = TIMEOUT_SECONDS;
      const json = await req.loadJSON();
      const code = req.response && req.response.statusCode;
      if (code && code !== 200) throw new Error(`HTTP ${code}`);
      return json;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(String(e));
    return null;
  }
}

async function geocode(postcode, state) {
  const key = postcode.replace(/\s+/g, "").toUpperCase();
  state.geo = state.geo || {};
  if (state.geo[key]) return state.geo[key];
  const json = await getJSON(`https://api.postcodes.io/postcodes/${encodeURIComponent(key)}`);
  const r = json && json.result;
  if (!r || typeof r.latitude !== "number" || typeof r.longitude !== "number") {
    throw new Error(`No coordinates for ${postcode}`);
  }
  state.geo[key] = { lat: r.latitude, lon: r.longitude };
  saveState(state);
  return state.geo[key];
}

async function fetchEta(from, to) {
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/` +
    `${from.lat},${from.lon}:${to.lat},${to.lon}/json` +
    `?key=${encodeURIComponent(CONFIG.TOMTOM_KEY)}` +
    `&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all`;
  const json = await getJSON(url);
  const s = json && json.routes && json.routes[0] && json.routes[0].summary;
  if (!s || !(s.travelTimeInSeconds > 0)) throw new Error("TomTom: no route");
  const usual = s.historicTrafficTravelTimeInSeconds || s.noTrafficTravelTimeInSeconds;
  const extraSeconds =
    usual > 0 ? s.travelTimeInSeconds - usual : s.trafficDelayInSeconds || 0;
  return {
    seconds: s.travelTimeInSeconds,
    extraMinutes: Math.round(extraSeconds / 60),
    miles: s.lengthInMeters / 1609.344,
    ts: Date.now(),
  };
}

const SEVERITY_RANK = { Severe: 3, Serious: 2, Moderate: 1 };

function tidyLocation(text) {
  return String(text || "")
    .replace(/\([^)]*\)/g, " ") // drop "(E14 ,E3 ) (Tower Hamlets)"
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
    .replace(/\b([ABM])(\d+)\b/gi, (m, a, b) => a.toUpperCase() + b);
}

async function fetchTfl(bbox) {
  const road = encodeURIComponent(CONFIG.road);
  const status = await getJSON(`https://api.tfl.gov.uk/Road/${road}/Status`);
  const corridor = Array.isArray(status) ? status[0] : null;
  if (!corridor || !corridor.statusSeverity) throw new Error("TfL: no status");

  // Incidents are a bonus – a failure here must not lose the status.
  const incidents = [];
  const list = await attempt(() => getJSON(`https://api.tfl.gov.uk/Road/${road}/Disruption`));
  const now = Date.now();
  for (const d of Array.isArray(list) ? list : []) {
    const rank = SEVERITY_RANK[d.severity] || (d.hasClosures ? 1 : 0);
    if (!rank) continue;
    if (d.startDateTime && Date.parse(d.startDateTime) > now) continue;
    if (d.endDateTime && Date.parse(d.endDateTime) < now) continue;
    const xy = d.geography && d.geography.type === "Point" && d.geography.coordinates;
    if (!xy) continue;
    const [lon, lat] = xy;
    if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon) continue;
    incidents.push({
      rank,
      text: `${d.hasClosures ? "Closure" : d.category || "Incident"}: ${tidyLocation(d.location)}`,
    });
  }
  incidents.sort((a, b) => b.rank - a.rank);

  return {
    severity: corridor.statusSeverity,
    description: corridor.statusSeverityDescription || corridor.statusSeverity,
    incidents: incidents.slice(0, 2),
    ts: Date.now(),
  };
}

function bboxAround(a, b) {
  const pad = 0.015; // ~1 mile
  return {
    minLat: Math.min(a.lat, b.lat) - pad,
    maxLat: Math.max(a.lat, b.lat) + pad,
    minLon: Math.min(a.lon, b.lon) - pad,
    maxLon: Math.max(a.lon, b.lon) + pad,
  };
}

// Fetch everything; fall back per-field to recent cached values.
async function getLive(reversed, state) {
  const homeXY = await attempt(() => geocode(CONFIG.home.postcode, state));
  const shopXY = await attempt(() => geocode(CONFIG.shop.postcode, state));
  const haveXY = homeXY && shopXY;
  const bbox = haveXY ? bboxAround(homeXY, shopXY) : FALLBACK_BBOX;
  const from = reversed ? shopXY : homeXY;
  const to = reversed ? homeXY : shopXY;

  const [tfl, eta] = await Promise.all([
    attempt(() => fetchTfl(bbox)),
    CONFIG.TOMTOM_KEY && haveXY ? attempt(() => fetchEta(from, to)) : null,
  ]);

  const cache = state.live && state.live.reversed === reversed ? state.live : {};
  const fresh = (v) => (v && Date.now() - v.ts < STALE_AFTER_MIN * 60000 ? v : null);
  const live = { reversed, tfl: tfl || fresh(cache.tfl), eta: eta || fresh(cache.eta) };
  if (tfl || eta) {
    state.live = live;
    saveState(state);
  }
  return live;
}

// ───────────────────────── Direction + links ─────────────────────────
function isReversed(state) {
  const d = state.direction;
  return !!(d && d.reversed && Date.now() - d.ts < DIRECTION_RESET_HOURS * 3600000);
}

function mapsUrl(reversed) {
  const from = encodeURIComponent(reversed ? CONFIG.shop.maps : CONFIG.home.maps);
  const to = encodeURIComponent(reversed ? CONFIG.home.maps : CONFIG.shop.maps);
  return CONFIG.useGoogleMapsAppScheme
    ? `comgooglemaps://?saddr=${from}&daddr=${to}&directionsmode=driving`
    : `https://www.google.com/maps/dir/?api=1&origin=${from}&destination=${to}&travelmode=driving`;
}

function runSelfUrl(action) {
  return `scriptable:///run/${encodeURIComponent(Script.name())}?action=${action}`;
}

// ───────────────────────── Widget building ─────────────────────────
function addText(stack, value, font, color, minScale) {
  const t = stack.addText(value);
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  if (minScale) t.minimumScaleFactor = minScale;
  return t;
}

function baseWidget(reversed) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = mapsUrl(reversed); // tapping anywhere (not on a button) opens the route
  return w;
}

function routeTitle(reversed) {
  const a = reversed ? CONFIG.shop.label : CONFIG.home.label;
  const b = reversed ? CONFIG.home.label : CONFIG.shop.label;
  return `${a} → ${b}`;
}

function buildOffHours(reversed, small) {
  const w = baseWidget(reversed);
  const win = CONFIG.window;
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;

  addText(w, routeTitle(reversed), Font.semiboldSystemFont(small ? 12 : 15), C.text, 0.6);
  w.addSpacer();

  const row = w.addStack();
  if (!small) row.addSpacer();
  const btn = row.addStack();
  btn.backgroundColor = C.link;
  btn.cornerRadius = 12;
  btn.setPadding(small ? 9 : 11, small ? 10 : 18, small ? 9 : 11, small ? 10 : 18);
  btn.url = mapsUrl(reversed);
  addText(
    btn,
    small ? "Open in Maps ↗" : "Open route in Google Maps ↗",
    Font.boldSystemFont(small ? 13 : 16),
    C.bg,
    0.7
  );
  if (!small) row.addSpacer();

  w.addSpacer();
  addText(
    w,
    `Live traffic ${DAYS[win.day]} ${hh(win.startHour)}–${hh(win.endHour)}`,
    Font.systemFont(11),
    C.dim,
    0.7
  );
  return w;
}

function headline(live) {
  if (live.eta) {
    const x = live.eta.extraMinutes;
    const delta = `${x >= 0 ? "+" : "−"}${Math.abs(x)}m`;
    if (x <= 2) return { text: `Normal (${delta})`, color: C.good };
    if (x <= 6) return { text: `Slower (${delta})`, color: C.warn };
    return { text: `Heavy (${delta})`, color: C.bad };
  }
  if (live.tfl) {
    const color =
      live.tfl.severity === "Good" ? C.good : live.tfl.severity === "Minor" ? C.warn : C.bad;
    return { text: live.tfl.description, color };
  }
  return { text: "No live data", color: C.dim };
}

function buildLive(live, reversed, small) {
  const w = baseWidget(reversed);
  const now = new Date();
  const eta = live.eta;
  const minutes = eta ? Math.max(1, Math.round(eta.seconds / 60)) : CONFIG.typicalMinutes;
  const miles = eta ? eta.miles : CONFIG.typicalMiles;
  const head = headline(live);

  // Row 1: route + Reverse
  const top = w.addStack();
  top.centerAlignContent();
  addText(top, routeTitle(reversed), Font.semiboldSystemFont(small ? 11 : 14), C.text, 0.6);
  if (!small) {
    top.addSpacer(8);
    top.addSpacer();
    const pill = top.addStack();
    pill.backgroundColor = C.pill;
    pill.cornerRadius = 8;
    pill.setPadding(4, 9, 4, 9);
    pill.url = runSelfUrl("reverse");
    addText(pill, "⇄ Reverse", Font.semiboldSystemFont(12), C.text);
  }

  w.addSpacer(small ? 4 : 6);

  // Row 2: time on the left, road conditions on the right
  const mid = w.addStack();
  mid.centerAlignContent();

  const left = mid.addStack();
  left.layoutVertically();
  addText(left, `${eta ? "" : "~"}${minutes}m`, Font.heavySystemFont(small ? 34 : 38), C.text, 0.6);
  addText(left, head.text, Font.semiboldSystemFont(small ? 11 : 12), head.color, 0.6);
  addText(
    left,
    eta ? `Arrive ${londonClock(new Date(now.getTime() + eta.seconds * 1000))}` : "Typical time",
    Font.mediumSystemFont(small ? 11 : 12),
    eta ? C.good : C.dim,
    0.7
  );

  if (!small) {
    mid.addSpacer(12);
    mid.addSpacer();
    const panel = mid.addStack();
    panel.layoutVertically();
    panel.backgroundColor = C.panel;
    panel.cornerRadius = 10;
    panel.setPadding(8, 10, 8, 10);
    panel.size = new Size(178, 0);

    const lines = [];
    if (live.tfl) {
      lines.push(`🚦 ${CONFIG.road}: ${live.tfl.description}`);
      for (const i of live.tfl.incidents) lines.push(`⚠️ ${i.text}`);
      if (!live.tfl.incidents.length) lines.push("✅ No major incidents on route");
    } else {
      lines.push("🚦 TfL status unavailable");
    }
    lines.forEach((line, i) => {
      if (i) panel.addSpacer(3);
      const row = panel.addStack(); // full-width row keeps text left-aligned
      addText(row, line, Font.systemFont(11), C.text, 0.7);
      row.addSpacer();
    });
  }

  w.addSpacer();

  // Footer: provenance on the left, Maps link on the right
  const foot = w.addStack();
  foot.centerAlignContent();
  const dataTs = Math.min(...[live.eta, live.tfl].filter(Boolean).map((v) => v.ts));
  const stamp = isFinite(dataTs) ? londonClock(new Date(dataTs)) : "";
  const source = eta ? "TomTom + TfL" : live.tfl ? "TfL" : "offline";
  addText(
    foot,
    small ? `${stamp || "offline"} · Maps ↗` : `${miles.toFixed(1)} mi via ${CONFIG.via} · ${source} ${stamp}`.trim(),
    Font.systemFont(10),
    C.dim,
    0.6
  );
  if (!small) {
    foot.addSpacer(6);
    foot.addSpacer();
    addText(foot, "Google Maps ↗", Font.semiboldSystemFont(11), C.link);
  }
  return w;
}

// ───────────────────────── Main ─────────────────────────
async function main() {
  const state = loadState();
  const action = (args.queryParameters || {}).action;

  if (action === "reverse") {
    state.direction = { reversed: !isReversed(state), ts: Date.now() };
    saveState(state);
  }

  const reversed = isReversed(state);
  const small = config.widgetFamily === "small";
  const now = new Date();
  const win = windowInfo(now);
  const liveMode = win.open || CONFIG.forceLive;

  let widget;
  try {
    widget = liveMode
      ? buildLive(await getLive(reversed, state), reversed, small)
      : buildOffHours(reversed, small);
  } catch (e) {
    // Whatever goes wrong, the Maps button must still be there.
    console.error(String(e));
    widget = buildOffHours(reversed, small);
  }

  // Ask iOS to come back when it matters: often while live, and exactly at
  // the moment the window opens or closes.
  const waitMin = win.open
    ? Math.min(REFRESH_MINUTES, win.minsToClose)
    : Math.min(60, Math.max(1, win.minsToOpen));
  widget.refreshAfterDate = new Date(now.getTime() + waitMin * 60000);

  Script.setWidget(widget);
  if (!config.runsInWidget) {
    if (small) await widget.presentSmall();
    else await widget.presentMedium();
  }
  Script.complete();
}

await main();
