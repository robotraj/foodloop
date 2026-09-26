// Agent 3 — Publisher & Notifier.
// Turns a surplus report into a listing in the app, applies the purchase limits, and alerts
// every user whose notification radius covers the restaurant.
import { z } from "zod";
import { config } from "../config.js";
import { askStructured } from "../llm.js";
import { distanceKm } from "../geo.js";
import { broadcast, push } from "../notify.js";
import { db, newId, nowIso, save, type Listing, type Notification, type Restaurant } from "../store.js";
import type { SurplusReport } from "./outreach.js";

const ListingCopy = z.object({
  title: z.string().describe("Appetising title, max 60 characters, no emoji"),
  description: z.string().describe("1-2 sentences for app users. Mention it is rescued surplus. No prices, no invented details."),
});

const HOUR = 60 * 60 * 1000;

/** Use the restaurant's window when it is sensible, otherwise default to the next two hours. */
function pickupWindow(report: SurplusReport): { start: Date; end: Date } {
  const now = Date.now();
  const start = new Date(report.pickup_start);
  const end = new Date(report.pickup_end);
  const valid =
    !isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start && end.getTime() > now && end.getTime() - now < 24 * HOUR;
  if (valid) return { start, end };
  return { start: new Date(now), end: new Date(now + 2 * HOUR) };
}

async function writeCopy(restaurant: Restaurant, report: SurplusReport) {
  const items = report.items.map((i) => `${i.portions}x ${i.name}`).join(", ");
  if (config.offline) {
    return {
      title: `Rescued food from ${restaurant.name}`.slice(0, 60),
      description: `Surplus from today: ${items}. Reserve a portion and help keep good food out of the bin.`,
    };
  }
  return askStructured({
    system: "You write listings for FoodLoop, an app where Amsterdam locals reserve surplus restaurant food at a fair base price with an optional tip.",
    prompt: `Restaurant: ${restaurant.name}${restaurant.cuisine ? ` (${restaurant.cuisine})` : ""}\nItems: ${items}\nDietary: ${report.dietary.join(", ") || "not specified"}`,
    schema: ListingCopy,
    effort: "low",
  });
}

export interface PublishResult {
  listing: Listing;
  notifiedUsers: number;
}

export async function publishListing(restaurant: Restaurant, report: SurplusReport, opts: { demo?: boolean } = {}): Promise<PublishResult> {
  const items = report.items.filter((i) => i.portions > 0);
  const totalPortions = items.reduce((sum, i) => sum + i.portions, 0);
  const { start, end } = pickupWindow(report);
  const copy = await writeCopy(restaurant, { ...report, items });

  const listing: Listing = {
    id: newId(),
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    title: copy.title,
    description: copy.description,
    items,
    dietary: report.dietary,
    totalPortions,
    remainingPortions: totalPortions,
    // Never let one person take more than the policy limit, and leave some for others on small batches.
    maxPerUser: Math.max(1, Math.min(config.maxPortionsPerListingPerUser, Math.ceil(totalPortions / 2))),
    pickupStart: start.toISOString(),
    pickupEnd: end.toISOString(),
    lat: restaurant.lat,
    lng: restaurant.lng,
    address: restaurant.address,
    status: "active",
    ...(opts.demo ? { demo: true } : {}),
    createdAt: nowIso(),
  };
  db.listings.push(listing);

  const notified: Notification[] = [];
  for (const user of db.users) {
    if (user.bot) continue;
    const km = distanceKm(user, listing);
    if (km > user.radiusKm) continue;
    const notification: Notification = {
      id: newId(),
      userId: user.id,
      listingId: listing.id,
      text: `${listing.title} — ${totalPortions} portions ${km.toFixed(1)} km away at ${restaurant.name}`,
      createdAt: nowIso(),
    };
    db.notifications.push(notification);
    notified.push(notification);
  }
  save();
  notified.forEach(push);
  broadcast("listing", listing);
  return { listing, notifiedUsers: notified.length };
}

/** Mark listings whose pickup window has passed as expired. */
export function expireListings(): void {
  const now = Date.now();
  let changed = false;
  for (const l of db.listings) {
    if (l.status === "active" && new Date(l.pickupEnd).getTime() < now) {
      l.status = "expired";
      changed = true;
      broadcast("listing", l);
    }
  }
  if (changed) save();
}
