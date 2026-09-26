// Central place for policy knobs. Override any of these with environment variables or a .env file.

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num("PORT", 3000),
  dataFile: process.env.FOODLOOP_DATA_FILE ?? "data/db.json",

  // Claude
  model: process.env.FOODLOOP_MODEL ?? "claude-opus-5",
  // Run without Claude (rule-based fallbacks) when explicitly asked or when no credentials are set.
  offline:
    process.env.FOODLOOP_OFFLINE === "1" ||
    (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN),

  // Purchase limits
  maxPortionsPerListingPerUser: num("MAX_PORTIONS_PER_LISTING", 2),
  maxReservationsPerDayPerUser: num("MAX_RESERVATIONS_PER_DAY", 2),

  // Donation (EUR) covers packaging + running the app. Users can give more, never less than the minimum.
  packagingPerPortion: num("PACKAGING_PER_PORTION", 0.75),
  platformFee: num("PLATFORM_FEE", 0.5),

  // Notifications
  defaultRadiusKm: num("DEFAULT_RADIUS_KM", 2),

  // Restaurant finder (OpenStreetMap Overpass API)
  overpassUrl: process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
};

export function minimumDonation(portions: number): number {
  return Math.round((config.packagingPerPortion * portions + config.platformFee) * 100) / 100;
}
