// Live simulation for testing. Real Amsterdam restaurants (from OpenStreetMap) "reply" with made-up
// surplus, which goes through the real outreach → publisher pipeline; simulated neighbours then
// reserve portions under the same limits as real users. Everything it publishes is flagged demo.
import { config, minimumDonation } from "./config.js";
import { db, newId, nowIso, save, type Restaurant } from "./store.js";
import { AMSTERDAM_CENTER, distanceKm } from "./geo.js";
import { broadcast } from "./notify.js";
import { contactRestaurant, handleReply } from "./agents/outreach.js";
import { expireListings } from "./agents/publisher.js";
import { findRestaurants } from "./agents/finder.js";
import { reserve } from "./reservations.js";

export interface Activity {
  at: string;
  kind: "restaurant" | "reservation" | "info";
  text: string;
}

const state = {
  running: false,
  intervalSec: 20,
  maxActiveListings: 14,
  timer: undefined as NodeJS.Timeout | undefined,
  busy: false,
  activity: [] as Activity[],
  pendingFollowUps: new Map<string, string>(), // restaurantId -> the answer to send next tick
};

const BOT_COUNT = 40;
const BOT_NAMES = ["Sanne", "Daan", "Emma", "Lucas", "Julia", "Sem", "Tess", "Milan", "Fleur", "Noah", "Lotte", "Finn", "Anouk", "Jesse", "Iris", "Bram", "Yara", "Thijs", "Noor", "Ruben", "Priya", "Omar", "Mei", "Ahmed", "Sofia", "Luca", "Aisha", "Mateo"];

const DISHES: [RegExp, string[]][] = [
  [/pizza|italian/, ["lasagne", "margherita slices", "penne arrabbiata", "tiramisu", "risotto"]],
  [/bakery|bagel|coffee|cake|breakfast|sandwich/, ["croissants", "sourdough loaves", "cinnamon buns", "sandwiches", "apple pie slices"]],
  [/indian|nepal|pakistan|sri/, ["chicken curry", "dal with rice", "vegetable biryani", "samosas", "paneer tikka"]],
  [/sushi|japanese/, ["sushi boxes", "onigiri", "teriyaki bowls", "gyoza"]],
  [/chinese|thai|asian|vietnam|korean|indonesian|noodle|ramen/, ["pad thai", "fried rice", "noodle boxes", "dumplings", "nasi goreng"]],
  [/burger|american|chicken|fast/, ["burgers", "veggie wraps", "chicken wings", "fries"]],
  [/dutch|regional|friture|snack/, ["stamppot", "erwtensoep", "kroketten", "bitterballen"]],
  [/turkish|lebanese|middle|kebab|falafel|greek|mediterranean|syrian|moroccan/, ["falafel wraps", "shawarma plates", "mezze boxes", "hummus bowls"]],
  [/mexican|latin|burrito|taco/, ["burritos", "tacos", "chili bowls"]],
];
const DEFAULT_DISHES = ["soup", "salad bowls", "pasta", "sandwiches", "quiche slices"];

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

function log(kind: Activity["kind"], text: string) {
  const entry = { at: nowIso(), kind, text };
  state.activity.unshift(entry);
  state.activity.length = Math.min(state.activity.length, 60);
  broadcast("activity", entry);
  console.log(`[sim] ${text}`);
}

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });

function pickupTimes(): [string, string] {
  const start = new Date(Date.now() + rand(2, 8) * 5 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5, 0, 0);
  const end = new Date(start.getTime() + rand(9, 24) * 5 * 60_000);
  return [hhmm(start), hhmm(end)];
}

function dishesFor(restaurant: Restaurant): string[] {
  const key = `${restaurant.cuisine ?? ""} ${restaurant.name}`.toLowerCase();
  return DISHES.find(([re]) => re.test(key))?.[1] ?? DEFAULT_DISHES;
}

/** A realistic reply, in English or Dutch, that the outreach agent has to read. */
function composeReply(restaurant: Restaurant): { text: string; followUpAnswer?: string } {
  const roll = Math.random();
  if (roll < 0.12) return { text: pick(["Sorry, nothing left today!", "Nee, vandaag helaas niets.", "Not today, we sold out."]) };

  const dishes = [...dishesFor(restaurant)].sort(() => Math.random() - 0.5).slice(0, rand(1, 2));
  const [start, end] = pickupTimes();
  if (roll < 0.22) {
    return {
      text: pick(["Yes, we have some leftovers today", "Ja, we hebben wel wat over"]),
      followUpAnswer: `About ${rand(4, 9)} portions of ${dishes[0]}, pickup ${start}-${end}`,
    };
  }
  const veg = Math.random() < 0.25 ? ", all vegetarian" : "";
  if (Math.random() < 0.3) {
    const items = dishes.map((d) => `${rand(3, 8)} porties ${d}`).join(" en ");
    return { text: `Hoi! We hebben ${items}${veg}. Ophalen ${start} tot ${end}.` };
  }
  const items = dishes.map((d, i) => (i === 0 ? `${rand(4, 10)} portions of ${d}` : `${rand(3, 6)} ${d}`)).join(" and ");
  return { text: pick([`Ja! We have ${items}${veg}, pickup ${start}-${end}`, `Yes — ${items} left today${veg}. Pickup ${start}-${end}`]) };
}

function ensureBots() {
  const bots = db.users.filter((u) => u.bot).length;
  for (let i = bots; i < BOT_COUNT; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const km = Math.sqrt(Math.random()) * 4.5;
    db.users.push({
      id: newId(),
      name: `${pick(BOT_NAMES)} (sim)`,
      lat: AMSTERDAM_CENTER.lat + (km / 111) * Math.sin(angle),
      lng: AMSTERDAM_CENTER.lng + (km / (111 * Math.cos((AMSTERDAM_CENTER.lat * Math.PI) / 180))) * Math.cos(angle),
      radiusKm: rand(1, 3),
      bot: true,
      createdAt: nowIso(),
    });
  }
  save();
}

async function restaurantEvent() {
  // Answer a follow-up question from last tick first.
  const [followUpId, answer] = state.pendingFollowUps.entries().next().value ?? [];
  if (followUpId && answer) {
    state.pendingFollowUps.delete(followUpId);
    const r = db.restaurants.find((x) => x.id === followUpId)!;
    const result = await handleReply(r.id, answer, { demo: true });
    log("restaurant", result.published ? `${r.name} answered: ${result.published.listing.totalPortions} portions now live` : `${r.name} answered the follow-up`);
    return;
  }

  const active = db.listings.filter((l) => l.status === "active" && l.demo).length;
  if (active >= state.maxActiveListings) return;

  const withLiveListing = new Set(db.listings.filter((l) => l.status === "active").map((l) => l.restaurantId));
  const candidates = db.restaurants.filter((r) => r.osmId && r.status !== "opted_out" && !withLiveListing.has(r.id) && !state.pendingFollowUps.has(r.id));
  const fresh = candidates.filter((r) => r.status === "new");
  const restaurant = pick(fresh.length ? fresh : candidates);
  if (!restaurant) return;

  await contactRestaurant(restaurant);
  const reply = composeReply(restaurant);
  const result = await handleReply(restaurant.id, reply.text, { demo: true });
  if (result.published) {
    const l = result.published.listing;
    log("restaurant", `${restaurant.name} posted ${l.totalPortions} portions (${l.items.map((i) => i.name).join(", ")}) · ${result.published.notifiedUsers} user(s) alerted`);
  } else if (result.followUpSent && reply.followUpAnswer) {
    state.pendingFollowUps.set(restaurant.id, reply.followUpAnswer);
    log("restaurant", `${restaurant.name} replied vaguely; the agent asked how many portions`);
  } else {
    log("restaurant", `${restaurant.name}: no surplus today`);
  }
}

function neighbourEvents() {
  const bots = db.users.filter((u) => u.bot);
  for (const listing of db.listings.filter((l) => l.status === "active")) {
    if (Math.random() > 0.4) continue;
    const nearby = bots.filter((b) => distanceKm(b, listing) <= Math.max(b.radiusKm, 2.5));
    const bot = pick(nearby.length ? nearby : bots);
    if (!bot) continue;
    const portions = Math.min(rand(1, listing.maxPerUser), listing.remainingPortions);
    try {
      reserve({ userId: bot.id, listingId: listing.id, portions, donation: minimumDonation(portions) + pick([0, 0, 0, 0.5, 1, 2]) });
      log("reservation", `${bot.name.replace(" (sim)", "")} reserved ${portions} at ${listing.restaurantName} · ${listing.remainingPortions} left`);
    } catch {
      // Hit a limit or sold out — exactly what should happen; try another listing next tick.
    }
  }
}

async function tick() {
  if (state.busy) return;
  state.busy = true;
  try {
    expireListings();
    await restaurantEvent();
    neighbourEvents();
  } catch (err) {
    log("info", `Simulator error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.busy = false;
  }
}

async function ensureRestaurants() {
  if (db.restaurants.filter((r) => r.osmId).length >= 100) return;
  log("info", "Fetching real Amsterdam restaurants from OpenStreetMap…");
  const { added } = await findRestaurants({ limit: 800 });
  log("info", `Added ${added} restaurants from OpenStreetMap`);
}

export async function startSimulator(opts: { intervalSec?: number; warmUp?: number } = {}) {
  if (opts.intervalSec) state.intervalSec = Math.max(5, opts.intervalSec);
  if (state.running) {
    clearInterval(state.timer);
  } else {
    state.running = true;
    log("info", `Simulator started (${config.offline ? "offline rule-based agents" : `Claude ${config.model}`})`);
    ensureBots();
    await ensureRestaurants();
    // Warm up so the app isn't empty on first load.
    for (let i = 0; i < (opts.warmUp ?? 5); i++) await tick();
  }
  state.timer = setInterval(tick, state.intervalSec * 1000);
  state.timer.unref();
  broadcast("simulator", simulatorStatus());
}

export function stopSimulator() {
  clearInterval(state.timer);
  state.running = false;
  log("info", "Simulator paused");
  broadcast("simulator", simulatorStatus());
}

export function simulatorStatus() {
  return {
    running: state.running,
    intervalSec: state.intervalSec,
    usesClaude: !config.offline,
    bots: db.users.filter((u) => u.bot).length,
    activity: state.activity,
  };
}

/** Remove everything the simulator created; real restaurants and real users stay. */
export function clearSimulatedData() {
  const demoListings = new Set(db.listings.filter((l) => l.demo).map((l) => l.id));
  const bots = new Set(db.users.filter((u) => u.bot).map((u) => u.id));
  db.listings = db.listings.filter((l) => !demoListings.has(l.id));
  db.reservations = db.reservations.filter((r) => !demoListings.has(r.listingId) && !bots.has(r.userId));
  db.notifications = db.notifications.filter((n) => !demoListings.has(n.listingId));
  db.users = db.users.filter((u) => !u.bot);
  db.messages = [];
  for (const r of db.restaurants) if (r.status !== "opted_out") r.status = "new";
  state.pendingFollowUps.clear();
  save();
  if (state.running) ensureBots();
  log("info", "Cleared simulated data");
  broadcast("listing", null);
}
