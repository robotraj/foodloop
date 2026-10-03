// Agent 5 — Forecast.
// Predicts which restaurants will have surplus today from their history (same weekday first,
// then all days), so outreach can message the likely ones instead of everyone.
import { db, type Restaurant } from "../store.js";

export interface Forecast {
  restaurantId: string;
  restaurantName: string;
  /** Expected surplus portions today. */
  expectedPortions: number;
  /** Share of past days with any surplus, 0-1. */
  chance: number;
  /** Days of history behind the prediction. */
  samples: number;
  basis: string;
}

const TZ = "Europe/Amsterdam";
const dayKey = (iso: string | Date) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const weekday = (iso: string | Date) => new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, weekday: "long" });
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Edible surplus portions per day the restaurant answered us (0 on days it had nothing). */
function history(restaurant: Restaurant): Map<string, number> {
  const days = new Map<string, number>();
  for (const m of db.messages) {
    if (m.restaurantId === restaurant.id && m.direction === "inbound") days.set(dayKey(m.createdAt), 0);
  }
  for (const d of db.dispositions) {
    // Only edible surplus is worth an outreach message.
    if (d.restaurantId !== restaurant.id || d.action === "compost" || d.action === "biogas") continue;
    const key = dayKey(d.createdAt);
    days.set(key, (days.get(key) ?? 0) + d.portions);
  }
  return days;
}

export function forecastRestaurant(restaurant: Restaurant, now = new Date()): Forecast | undefined {
  const days = history(restaurant);
  // Today's own replies don't predict today.
  days.delete(dayKey(now));
  if (!days.size) return undefined;

  const today = weekday(now);
  const sameDay = [...days].filter(([key]) => weekday(`${key}T12:00:00Z`) === today).map(([, v]) => v);
  const all = [...days.values()];
  // Two or more same-weekday samples beat the overall average; otherwise blend towards it.
  const expected = sameDay.length >= 2 ? mean(sameDay) : sameDay.length === 1 ? (sameDay[0] + mean(all)) / 2 : mean(all);
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    expectedPortions: Math.round(expected * 10) / 10,
    chance: Math.round((all.filter((v) => v > 0).length / all.length) * 100) / 100,
    samples: all.length,
    basis: sameDay.length
      ? `${sameDay.length} past ${today}${sameDay.length > 1 ? "s" : ""} and ${all.length} day(s) in total`
      : `${all.length} past day(s); no ${today} yet`,
  };
}

/** Restaurants ranked by expected surplus today. Opted-out restaurants are never included. */
export function forecastAll(now = new Date()): Forecast[] {
  return db.restaurants
    .filter((r) => r.status !== "opted_out")
    .flatMap((r) => forecastRestaurant(r, now) ?? [])
    .sort((a, b) => b.expectedPortions * b.chance - a.expectedPortions * a.chance);
}

/** Likely-surplus restaurants we haven't contacted today, best first. */
export function forecastTargets(limit: number, now = new Date()): Restaurant[] {
  const today = dayKey(now);
  return forecastAll(now)
    .filter((f) => f.expectedPortions > 0)
    .map((f) => db.restaurants.find((r) => r.id === f.restaurantId)!)
    .filter((r) => !r.lastContactedAt || dayKey(r.lastContactedAt) !== today)
    .slice(0, limit);
}
