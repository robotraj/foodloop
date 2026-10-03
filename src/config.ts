// Central place for policy knobs. Override any of these with environment variables or a .env file.

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num("PORT", 3000),
  dataFile:
    process.env.FOODLOOP_DATA_FILE ??
    (process.env.VERCEL === "1" || process.env.VERCEL === "true" ? "/tmp/foodloop-db.json" : "data/db.json"),

  // Claude
  model: process.env.FOODLOOP_MODEL ?? "claude-opus-5",
  // Run without Claude (rule-based fallbacks) when explicitly asked or when no credentials are set.
  offline:
    process.env.FOODLOOP_OFFLINE === "1" ||
    (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN),

  // Purchase limits
  maxPortionsPerListingPerUser: num("MAX_PORTIONS_PER_LISTING", 2),
  maxReservationsPerDayPerUser: num("MAX_RESERVATIONS_PER_DAY", 2),

  // Base food price (EUR) plus an optional user tip.
  basePricePerPortion: num("BASE_PRICE_PER_PORTION", 2.5),

  // Router: when surplus is donated, composted or sent to biogas instead of sold in the app
  donateMinPortions: num("DONATE_MIN_PORTIONS", 20),
  biogasMinPortions: num("BIOGAS_MIN_PORTIONS", 20),
  minSellMinutes: num("MIN_SELL_MINUTES", 20),

  // Impact estimates (rough): weight of a portion, CO2e avoided per kg of food rescued,
  // compost made per kg composted, and biogas per kg digested.
  kgPerPortion: num("KG_PER_PORTION", 0.4),
  co2ePerKgRescued: num("CO2E_PER_KG_RESCUED", 2.5),
  compostYield: num("COMPOST_YIELD", 0.3),
  biogasM3PerKg: num("BIOGAS_M3_PER_KG", 0.12),

  // Notifications
  defaultRadiusKm: num("DEFAULT_RADIUS_KM", 2),

  // Restaurant finder: Google Places API (New) when a key is set, otherwise OpenStreetMap (Overpass API)
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY?.trim() || undefined,
  googlePlacesTypes: (process.env.GOOGLE_PLACES_TYPES?.trim() || "restaurant,cafe,meal_takeaway")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  overpassUrl: process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
  // Real restaurants saved with `npm run snapshot`; the hosted app starts with these.
  restaurantSnapshotFile: process.env.RESTAURANT_SNAPSHOT_FILE ?? "seed/amsterdam-restaurants.json",

  // Map in the user app (Maps JavaScript API). This key is sent to browsers: restrict it by HTTP referrer.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
  googleMapsMapId: process.env.GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID",

  // Outreach agent: real email via Resend (https://resend.com). Drafts are only sent after approval
  // in the agent console, at most `outreachDailyCap` first-contact emails per day.
  resendApiKey: process.env.RESEND_API_KEY?.trim() || undefined,
  outreachFrom: process.env.OUTREACH_FROM_EMAIL?.trim() || undefined, // e.g. "FoodLoop <hello@yourdomain.nl>"
  outreachReplyTo: process.env.OUTREACH_REPLY_TO?.trim() || undefined,
  // Who is sending: name and postal address, shown in every email's footer.
  outreachSenderInfo: process.env.OUTREACH_SENDER_INFO?.trim() || undefined,
  outreachDailyCap: num("OUTREACH_DAILY_CAP", 20),
  // Shared secret for the inbound-email webhook: POST /api/inbound/email?secret=...
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET?.trim() || undefined,
};

export function basePrice(portions: number): number {
  return Math.round(config.basePricePerPortion * portions * 100) / 100;
}
