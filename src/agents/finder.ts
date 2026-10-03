// Agent 1 — Restaurant Finder.
// Pulls restaurants, cafés and takeaways in Amsterdam and upserts them into the database.
// Source: Google Places API (New) when GOOGLE_PLACES_API_KEY is set, otherwise OpenStreetMap.
// Deterministic: no LLM needed for this step.
import { config } from "../config.js";
import { AMSTERDAM_CENTER, distanceKm } from "../geo.js";
import { db, newId, save, type Restaurant } from "../store.js";

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const query = (limit?: number) => `
[out:json][timeout:120];
area["name"="Amsterdam"]["boundary"="administrative"]["admin_level"="8"]->.ams;
(
  nwr["amenity"~"^(restaurant|cafe|fast_food)$"]["name"](area.ams);
);
out center tags${limit ? ` ${limit}` : ""};
`;

// Overpass is a free shared service and returns 429/504 when busy; retry once after a pause.
async function overpass(body: string): Promise<OsmElement[]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(config.overpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "FoodLoop/0.1 (food surplus prototype)",
      },
      body: new URLSearchParams({ data: body }),
    });
    if (res.ok) return ((await res.json()) as { elements: OsmElement[] }).elements;
    if (attempt >= 2 || ![429, 502, 503, 504].includes(res.status)) {
      throw new Error(`Overpass API returned ${res.status} — it may be busy, try again in a minute or set OVERPASS_URL to a mirror`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function toAddress(tags: Record<string, string>): string {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const city = [tags["addr:postcode"], tags["addr:city"] ?? "Amsterdam"].filter(Boolean).join(" ");
  return [street, city].filter(Boolean).join(", ");
}

export type FinderSource = "google" | "osm";

export interface FinderResult {
  source: FinderSource;
  found: number;
  added: number;
  /** Google only: number of billed Places API requests. */
  requests?: number;
}

/** Uses Google Places when a key is configured, unless a source is given explicitly. */
export async function findRestaurants(opts: { limit?: number; source?: FinderSource } = {}): Promise<FinderResult> {
  const source = opts.source ?? (config.googlePlacesApiKey ? "google" : "osm");
  if (source === "google") return findGooglePlaces(opts);
  return { source, ...(await findOsm(opts)) };
}

export type RestaurantFields = Omit<Restaurant, "id" | "status" | "lastContactedAt">;

/** Named restaurants, cafés and takeaways in Amsterdam from OpenStreetMap. */
export async function fetchOsmRestaurants(limit?: number): Promise<RestaurantFields[]> {
  const elements = await overpass(query(limit));
  return elements.flatMap((el) => {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!tags.name || lat === undefined || lng === undefined) return [];
    return [
      {
        osmId: `${el.type}/${el.id}`,
        name: tags.name,
        lat,
        lng,
        address: toAddress(tags),
        phone: tags.phone ?? tags["contact:phone"],
        website: tags.website ?? tags["contact:website"],
        email: tags.email ?? tags["contact:email"],
        cuisine: tags.cuisine,
      },
    ];
  });
}

async function findOsm(opts: { limit?: number }): Promise<{ found: number; added: number }> {
  const found = await fetchOsmRestaurants(opts.limit);
  const byOsmId = new Map(db.restaurants.filter((r) => r.osmId).map((r) => [r.osmId!, r]));
  let added = 0;

  for (const fields of found) {
    const osmId = fields.osmId!;
    const existing = byOsmId.get(osmId);
    if (existing) {
      Object.assign(existing, fields);
    } else {
      const restaurant: Restaurant = { id: newId(), status: "new", ...fields };
      db.restaurants.push(restaurant);
      byOsmId.set(osmId, restaurant);
      added++;
    }
  }
  save();
  return { found: found.length, added };
}

// ---------- Google Places API (New) ----------
// Grid search over Amsterdam's bounding box: one Nearby Search per ~1 km cell; cells that hit the
// 20-result cap are split into 4 and searched again. Official API only (no scraping). place_id is kept
// permanently and the other fields are refreshed on every run, as Google's terms ask.

interface GooglePlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: string;
  primaryType?: string;
  location?: { latitude: number; longitude: number };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
}

const AMSTERDAM_BOUNDS = { south: 52.28, north: 52.43, west: 4.73, east: 5.07 };
const CELL_KM = 1;
const MIN_CELL_KM = 0.2;
const MAX_RESULTS = 20;
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.primaryType",
  "places.location",
  "places.regularOpeningHours.weekdayDescriptions",
].join(",");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function searchNearby(center: { lat: number; lng: number }, radiusM: number): Promise<GooglePlace[]> {
  for (let attempt = 1; ; attempt++) {
    // Stay around 5 requests per second.
    await sleep(Math.max(0, lastRequestAt + 200 - Date.now()));
    lastRequestAt = Date.now();
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey!,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: config.googlePlacesTypes,
        maxResultCount: MAX_RESULTS,
        locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
      }),
    });
    if (res.ok) return ((await res.json()) as { places?: GooglePlace[] }).places ?? [];
    if (attempt >= 4 || !(res.status === 429 || res.status >= 500)) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Google Places API returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

/** ~1 km square cells covering Amsterdam, nearest to the centre first so a limited run finds central places. */
function gridCells(): { lat: number; lng: number }[] {
  const latStep = CELL_KM / 111;
  const lngStep = CELL_KM / (111 * Math.cos((AMSTERDAM_CENTER.lat * Math.PI) / 180));
  const cells: { lat: number; lng: number }[] = [];
  for (let lat = AMSTERDAM_BOUNDS.south + latStep / 2; lat < AMSTERDAM_BOUNDS.north; lat += latStep) {
    for (let lng = AMSTERDAM_BOUNDS.west + lngStep / 2; lng < AMSTERDAM_BOUNDS.east; lng += lngStep) {
      cells.push({ lat, lng });
    }
  }
  return cells.sort((a, b) => distanceKm(AMSTERDAM_CENTER, a) - distanceKm(AMSTERDAM_CENTER, b));
}

const normalizeName = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

function cuisineFromType(type?: string): string | undefined {
  if (!type || type === "restaurant") return undefined;
  return type.replace(/_restaurant$/, "").replace(/_/g, " ");
}

async function findGooglePlaces(opts: { limit?: number }): Promise<FinderResult> {
  if (!config.googlePlacesApiKey) throw new Error("Set GOOGLE_PLACES_API_KEY to search with Google Places");

  const places = new Map<string, GooglePlace>();
  let requests = 0;
  const limitReached = () => opts.limit !== undefined && places.size >= opts.limit;

  // Search a square cell; split it into 4 when the API returns a full page (there are probably more).
  async function searchCell(center: { lat: number; lng: number }, sizeKm: number): Promise<void> {
    if (limitReached()) return;
    const radiusM = Math.round((sizeKm * 1000 * Math.SQRT2) / 2); // circle enclosing the square
    const results = await searchNearby(center, radiusM);
    requests++;
    for (const place of results) {
      if (place.businessStatus && place.businessStatus !== "OPERATIONAL") continue;
      if (!place.formattedAddress?.includes("Amsterdam")) continue;
      if (!place.displayName?.text || !place.location) continue;
      places.set(place.id, place);
    }
    if (results.length >= MAX_RESULTS && sizeKm / 2 >= MIN_CELL_KM) {
      const half = sizeKm / 2;
      const dLat = half / 2 / 111;
      const dLng = half / 2 / (111 * Math.cos((center.lat * Math.PI) / 180));
      for (const [sy, sx] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        await searchCell({ lat: center.lat + sy * dLat, lng: center.lng + sx * dLng }, half);
      }
    }
  }

  for (const cell of gridCells()) {
    if (limitReached()) break;
    await searchCell(cell, CELL_KM);
  }

  const found = [...places.values()].slice(0, opts.limit);
  const byPlaceId = new Map(db.restaurants.filter((r) => r.placeId).map((r) => [r.placeId!, r]));
  let added = 0;
  for (const place of found) {
    const fields = {
      placeId: place.id,
      name: place.displayName!.text,
      lat: place.location!.latitude,
      lng: place.location!.longitude,
      address: place.formattedAddress ?? "",
      phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber,
      website: place.websiteUri,
      cuisine: cuisineFromType(place.primaryType),
      openingHours: place.regularOpeningHours?.weekdayDescriptions,
    };
    // Match by place_id, or adopt a restaurant found earlier via OpenStreetMap (same name, within 100 m)
    // so it isn't contacted twice.
    const existing =
      byPlaceId.get(place.id) ??
      db.restaurants.find(
        (r) => !r.placeId && normalizeName(r.name) === normalizeName(fields.name) && distanceKm(r, fields) < 0.1,
      );
    if (existing) {
      Object.assign(existing, fields);
      byPlaceId.set(place.id, existing);
    } else {
      const restaurant: Restaurant = { id: newId(), status: "new", ...fields };
      db.restaurants.push(restaurant);
      byPlaceId.set(place.id, restaurant);
      added++;
    }
  }
  save();
  return { source: "google", found: found.length, added, requests };
}

/** A handful of made-up restaurants for demos when you don't want to hit the Overpass API. */
export function seedDemoRestaurants(): number {
  const demo: Omit<Restaurant, "id" | "status">[] = [
    { name: "De Groene Keuken (demo)", lat: 52.3702, lng: 4.8952, address: "Kalverstraat 10, Amsterdam", cuisine: "dutch" },
    { name: "Pasta Canale (demo)", lat: 52.3765, lng: 4.8836, address: "Prinsengracht 150, Amsterdam", cuisine: "italian" },
    { name: "Bakkerij Zuid (demo)", lat: 52.3555, lng: 4.8908, address: "Ferdinand Bolstraat 40, Amsterdam", cuisine: "bakery" },
    { name: "Spice Route Oost (demo)", lat: 52.3625, lng: 4.9305, address: "Javastraat 70, Amsterdam", cuisine: "indian" },
    { name: "Noord Noodle Bar (demo)", lat: 52.3905, lng: 4.9187, address: "Buiksloterweg 5, Amsterdam", cuisine: "asian" },
  ];
  let added = 0;
  for (const r of demo) {
    if (db.restaurants.some((existing) => existing.name === r.name)) continue;
    db.restaurants.push({ id: newId(), status: "new", ...r });
    added++;
  }
  save();
  return added;
}
