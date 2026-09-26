// Agent 1 — Restaurant Finder.
// Pulls restaurants, cafés and takeaways inside Amsterdam's municipal boundary from OpenStreetMap
// and upserts them into the database. Deterministic: no LLM needed for this step.
import { config } from "../config.js";
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

export async function findRestaurants(opts: { limit?: number } = {}): Promise<{ found: number; added: number }> {
  const elements = await overpass(query(opts.limit));
  const byOsmId = new Map(db.restaurants.filter((r) => r.osmId).map((r) => [r.osmId!, r]));
  let added = 0;

  for (const el of elements) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!tags.name || lat === undefined || lng === undefined) continue;

    const osmId = `${el.type}/${el.id}`;
    const fields = {
      osmId,
      name: tags.name,
      lat,
      lng,
      address: toAddress(tags),
      phone: tags.phone ?? tags["contact:phone"],
      website: tags.website ?? tags["contact:website"],
      email: tags.email ?? tags["contact:email"],
      cuisine: tags.cuisine,
    };
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
  return { found: elements.length, added };
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
