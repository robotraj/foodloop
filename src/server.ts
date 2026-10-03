import express, { type NextFunction, type Request, type Response } from "express";
import os from "node:os";
import { config } from "./config.js";
import { db, newId, nowIso, save, seedHostedDemoData } from "./store.js";
import { distanceKm, AMSTERDAM_CENTER } from "./geo.js";
import { subscribe, subscribePublic } from "./notify.js";
import { cancel, HttpError, reserve } from "./reservations.js";
import { clearSimulatedData, simulatorStatus, startSimulator, stopSimulator } from "./simulator.js";
import { findRestaurants, seedDemoRestaurants } from "./agents/finder.js";
import { handleReply, parseReplyOffline, runOutreach } from "./agents/outreach.js";
import { expireListings } from "./agents/publisher.js";
import path from "node:path";
import { suggestRecipes } from "./agents/chef.js";
import { forecastAll } from "./agents/forecast.js";
import { impact, loopRestaurants, seedDemoPartners } from "./impact.js";

export const app = express();
app.use(express.json());
const publicDir = path.resolve(process.cwd(), "public");
app.use(express.static(publicDir));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const numberOr = (value: unknown, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
};

function getUser(id: string) {
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

if (process.env.VERCEL === "1" || process.env.VERCEL === "true") seedHostedDemoData();
// Optional protection for the agent/admin endpoints: set ADMIN_TOKEN and send it as x-admin-token.
function admin(req: Request, _res: Response, next: NextFunction) {
  if (process.env.ADMIN_TOKEN && req.get("x-admin-token") !== process.env.ADMIN_TOKEN) {
    throw new HttpError(401, "Admin token required");
  }
  next();
}

// ---------- App (users) ----------

app.get("/api/config", (_req, res) => {
  res.json({
    offline: config.offline,
    model: config.offline ? null : config.model,
    maxPortionsPerListingPerUser: config.maxPortionsPerListingPerUser,
    maxReservationsPerDayPerUser: config.maxReservationsPerDayPerUser,
    basePricePerPortion: config.basePricePerPortion,
    defaultRadiusKm: config.defaultRadiusKm,
    center: AMSTERDAM_CENTER,
  });
});

// Public numbers for the landing page.
app.get("/api/stats", (_req, res) => {
  expireListings();
  const kept = db.reservations.filter((r) => r.status !== "cancelled");
  const { rescuedKg, co2eAvoidedKg } = impact();
  res.json({
    rescuedKg,
    co2eAvoidedKg,
    restaurants: db.restaurants.filter((r) => r.status !== "opted_out").length,
    liveListings: db.listings.filter((l) => l.status === "active").length,
    portionsRescued: kept.reduce((s, r) => s + r.portions, 0),
    portionsShared: db.listings.reduce((s, l) => s + l.totalPortions, 0),
  });
});

// Landing-page demo: shows how the outreach agent reads a reply. Rule-based only, so it costs nothing and stores nothing.
app.post("/api/demo/parse", (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 500);
  if (!text.trim()) throw new HttpError(400, "text is required");
  res.json(parseReplyOffline(text));
});

app.post("/api/users", (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
  const user = {
    id: newId(),
    name: name.trim().slice(0, 60),
    lat: numberOr(req.body.lat, AMSTERDAM_CENTER.lat),
    lng: numberOr(req.body.lng, AMSTERDAM_CENTER.lng),
    radiusKm: numberOr(req.body.radiusKm, config.defaultRadiusKm),
    createdAt: nowIso(),
  };
  db.users.push(user);
  save();
  res.status(201).json(user);
});

app.get("/api/users/:id", (req, res) => {
  res.json(getUser(req.params.id));
});

app.patch("/api/users/:id", (req, res) => {
  const user = getUser(req.params.id);
  user.lat = numberOr(req.body?.lat, user.lat);
  user.lng = numberOr(req.body?.lng, user.lng);
  user.radiusKm = Math.min(25, Math.max(0.5, numberOr(req.body?.radiusKm, user.radiusKm)));
  save();
  res.json(user);
});

app.get("/api/users/:id/events", (req, res) => {
  getUser(req.params.id);
  subscribe(req.params.id, res);
});

app.get("/api/users/:id/notifications", (req, res) => {
  res.json(db.notifications.filter((n) => n.userId === req.params.id).slice(-20).reverse());
});

app.get("/api/listings", (req, res) => {
  expireListings();
  const lat = numberOr(req.query.lat, AMSTERDAM_CENTER.lat);
  const lng = numberOr(req.query.lng, AMSTERDAM_CENTER.lng);
  const radiusKm = numberOr(req.query.radiusKm, 25);
  const loop = loopRestaurants();
  const listings = db.listings
    .filter((l) => l.status === "active")
    .map((l) => ({ ...l, closesLoop: loop.has(l.restaurantId), distanceKm: Math.round(distanceKm({ lat, lng }, l) * 10) / 10 }))
    .filter((l) => l.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  res.json(listings);
});

app.get("/api/restaurants/nearby", (req, res) => {
  const lat = numberOr(req.query.lat, AMSTERDAM_CENTER.lat);
  const lng = numberOr(req.query.lng, AMSTERDAM_CENTER.lng);
  const radiusKm = Math.min(25, Math.max(0.5, numberOr(req.query.radiusKm, 10)));
  const restaurants = db.restaurants
    .filter((restaurant) => restaurant.status !== "opted_out")
    .map((restaurant) => ({
      name: restaurant.name,
      address: restaurant.address,
      phone: restaurant.phone,
      website: restaurant.website,
      email: restaurant.email,
      cuisine: restaurant.cuisine,
      lat: restaurant.lat,
      lng: restaurant.lng,
      distanceKm: Math.round(distanceKm({ lat, lng }, restaurant) * 10) / 10,
    }))
    .filter((restaurant) => restaurant.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  res.json(restaurants);
});

app.post("/api/reservations", (req, res) => {
  expireListings();
  const { reservation, listing } = reserve({
    userId: String(req.body?.userId),
    listingId: String(req.body?.listingId),
    portions: numberOr(req.body?.portions, 1),
    tip: numberOr(req.body?.tip, 0),
  });
  res.status(201).json({ ...reservation, listing });
});

app.get("/api/users/:id/reservations", (req, res) => {
  const mine = db.reservations
    .filter((r) => r.userId === req.params.id)
    .map((r) => ({ ...r, listing: db.listings.find((l) => l.id === r.listingId) }))
    .reverse();
  res.json(mine);
});

app.post("/api/reservations/:id/cancel", (req, res) => {
  res.json(cancel(String(req.params.id), String(req.body?.userId)));
});

// Public live feed: listing changes and simulator activity.
app.get("/api/events", (_req, res) => {
  subscribePublic(res);
});

// ---------- Agents & admin ----------

app.get("/api/admin/overview", admin, (_req, res) => {
  expireListings();
  res.json({
    restaurants: db.restaurants.map((r) => ({
      ...r,
      messages: db.messages.filter((m) => m.restaurantId === r.id),
    })),
    listings: [...db.listings].reverse(),
    dispositions: db.dispositions.slice(-100).reverse(),
    partners: db.partners,
    stats: {
      users: db.users.length,
      reservations: db.reservations.filter((r) => r.status !== "cancelled").length,
      portionsRescued: db.reservations.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.portions, 0),
      tips: db.reservations.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.tip, 0),
      revenue: db.reservations.filter((r) => r.status !== "cancelled").reduce((s, r) => s + r.total, 0),
    },
  });
});

app.post("/api/agents/finder", admin, async (req, res) => {
  res.json(await findRestaurants({ limit: req.body?.limit ? numberOr(req.body.limit, 0) : undefined }));
});

app.post("/api/agents/seed", admin, (_req, res) => {
  res.json({ added: seedDemoRestaurants() });
});

app.post("/api/agents/outreach", admin, async (req, res) => {
  res.json(await runOutreach({ limit: numberOr(req.body?.limit, 5), smart: req.body?.smart === true }));
});

app.get("/api/admin/forecast", admin, (_req, res) => {
  res.json(forecastAll().slice(0, 25));
});

app.get("/api/admin/impact", admin, (_req, res) => {
  res.json(impact());
});

app.post("/api/agents/partners/seed", admin, (_req, res) => {
  const added = seedDemoPartners();
  save();
  res.json({ added });
});

// Chef agent: "bread, 3 rice, 2 kg potatoes" -> recipes. A leading number is read as portions.
app.post("/api/agents/chef", admin, async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 300);
  const items = text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)\s*(?:x|kg|portions?)?\s*(?:of\s+)?(.+)$/i);
      return m ? { name: m[2], portions: Number(m[1]) } : { name: s, portions: 1 };
    });
  if (!items.length) throw new HttpError(400, "List some leftovers, e.g. \"day-old bread, 3 portions of rice\"");
  res.json(await suggestRecipes(items));
});

app.post("/api/restaurants/:id/reply", admin, async (req, res) => {
  const text = req.body?.text;
  if (!text || typeof text !== "string") throw new HttpError(400, "text is required");
  res.json(await handleReply(String(req.params.id), text));
});

app.get("/api/simulator", admin, (_req, res) => {
  res.json(simulatorStatus());
});

app.post("/api/simulator", admin, async (req, res) => {
  if (req.body?.running === false) stopSimulator();
  else await startSimulator({ intervalSec: req.body?.intervalSec ? numberOr(req.body.intervalSec, 20) : undefined });
  res.json(simulatorStatus());
});

app.post("/api/simulator/clear", admin, (_req, res) => {
  clearSimulatedData();
  res.json(simulatorStatus());
});

// ---------- Errors ----------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

setInterval(expireListings, 60_000).unref();

if (process.env.VERCEL !== "1") {
  app.listen(config.port, () => {
    console.log(`FoodLoop running on http://localhost:${config.port}  (admin: /admin.html)`);
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family === "IPv4" && !net.internal) console.log(`  On your phone (same Wi-Fi): http://${net.address}:${config.port}`);
      }
    }
    console.log(config.offline ? "Claude: OFFLINE (rule-based fallbacks). Set ANTHROPIC_API_KEY to enable the AI agents." : `Claude: ${config.model}`);
    if (process.argv.includes("--simulate") || process.env.SIMULATE === "1") {
      startSimulator().catch((err) => console.error("Simulator failed to start:", err));
      console.log("Live simulation: ON (pause it in the agent console)");
    }
  });
}

export default app;
