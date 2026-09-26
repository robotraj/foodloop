// Tiny JSON-file database. Good enough for a prototype; swap for Postgres/SQLite when going live.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

export interface Restaurant {
  id: string;
  osmId?: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  phone?: string;
  website?: string;
  email?: string;
  cuisine?: string;
  status: "new" | "contacted" | "replied" | "opted_out";
  lastContactedAt?: string;
}

export interface OutreachMessage {
  id: string;
  restaurantId: string;
  direction: "outbound" | "inbound";
  text: string;
  createdAt: string;
}

export interface FoodItem {
  name: string;
  portions: number;
}

export interface Listing {
  id: string;
  restaurantId: string;
  restaurantName: string;
  title: string;
  description: string;
  items: FoodItem[];
  dietary: string[];
  totalPortions: number;
  remainingPortions: number;
  maxPerUser: number;
  pickupStart: string;
  pickupEnd: string;
  lat: number;
  lng: number;
  address: string;
  status: "active" | "sold_out" | "expired";
  /** Created by the simulator: real restaurant, made-up surplus. Shown with a "test data" badge. */
  demo?: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
  /** Simulated neighbour created by the simulator. */
  bot?: boolean;
  createdAt: string;
}

export interface Reservation {
  id: string;
  listingId: string;
  userId: string;
  portions: number;
  donation: number;
  pickupCode: string;
  status: "reserved" | "collected" | "cancelled";
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  listingId: string;
  text: string;
  createdAt: string;
}

interface Data {
  restaurants: Restaurant[];
  messages: OutreachMessage[];
  listings: Listing[];
  users: User[];
  reservations: Reservation[];
  notifications: Notification[];
}

const empty = (): Data => ({
  restaurants: [],
  messages: [],
  listings: [],
  users: [],
  reservations: [],
  notifications: [],
});

function load(): Data {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, "utf8")) };
  } catch {
    return empty();
  }
}

export const db: Data = load();

export function save(): void {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const tmp = `${config.dataFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.dataFile);
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
