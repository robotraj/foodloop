// Reservation rules shared by the HTTP API and the simulator, so simulated users obey the same limits.
import crypto from "node:crypto";
import { basePrice, config } from "./config.js";
import { db, newId, nowIso, save, type Reservation } from "./store.js";
import { broadcast } from "./notify.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const amsterdamDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });

export function reserve(opts: { userId: string; listingId: string; portions: number; tip: number }) {
  const user = db.users.find((u) => u.id === opts.userId);
  if (!user) throw new HttpError(404, "User not found");
  const listing = db.listings.find((l) => l.id === opts.listingId);
  if (!listing) throw new HttpError(404, "Listing not found");
  if (listing.status !== "active") throw new HttpError(409, `This listing is ${listing.status.replace("_", " ")}`);
  const portions = Math.floor(opts.portions);
  const tip = Math.round(opts.tip * 100) / 100;
  if (!(portions >= 1)) throw new HttpError(400, "Reserve at least 1 portion");

  const active = db.reservations.filter((r) => r.userId === user.id && r.status !== "cancelled");

  // Limit 1: portions per listing per user.
  const alreadyHere = active.filter((r) => r.listingId === listing.id).reduce((s, r) => s + r.portions, 0);
  if (alreadyHere + portions > listing.maxPerUser) {
    throw new HttpError(409, `Limit is ${listing.maxPerUser} portion(s) per person for this listing (you have ${alreadyHere})`);
  }
  // Limit 2: listings per user per day.
  const today = amsterdamDay(nowIso());
  const todayCount = new Set(
    active.filter((r) => amsterdamDay(r.createdAt) === today && r.listingId !== listing.id).map((r) => r.listingId),
  ).size;
  if (alreadyHere === 0 && todayCount >= config.maxReservationsPerDayPerUser) {
    throw new HttpError(409, `You can reserve from at most ${config.maxReservationsPerDayPerUser} listings per day`);
  }
  if (portions > listing.remainingPortions) throw new HttpError(409, `Only ${listing.remainingPortions} portion(s) left`);

  if (tip < 0) throw new HttpError(400, "Tip cannot be negative");
  const price = basePrice(portions);

  const reservation: Reservation = {
    id: newId(),
    listingId: listing.id,
    userId: user.id,
    portions,
    basePrice: price,
    tip,
    total: price + tip,
    pickupCode: crypto.randomInt(100000, 1000000).toString(),
    status: "reserved",
    createdAt: nowIso(),
  };
  listing.remainingPortions -= portions;
  if (listing.remainingPortions === 0) listing.status = "sold_out";
  db.reservations.push(reservation);
  save();
  broadcast("listing", listing);
  return { reservation, listing };
}

export function cancel(reservationId: string, userId: string): Reservation {
  const reservation = db.reservations.find((r) => r.id === reservationId);
  if (!reservation || reservation.userId !== userId) throw new HttpError(404, "Reservation not found");
  if (reservation.status !== "reserved") throw new HttpError(409, `Reservation is already ${reservation.status}`);
  reservation.status = "cancelled";
  const listing = db.listings.find((l) => l.id === reservation.listingId);
  if (listing && listing.status !== "expired") {
    listing.remainingPortions += reservation.portions;
    listing.status = "active";
    broadcast("listing", listing);
  }
  save();
  return reservation;
}
