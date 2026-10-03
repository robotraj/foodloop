// Tiny JSON-file database. Good enough for a prototype; swap for Postgres/SQLite when going live.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { Recipe } from "./agents/chef.js";

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

export type DispositionAction = "sell" | "donate" | "reuse" | "compost" | "biogas";

/** Where a batch of surplus went, as decided by the router agent. */
export interface Disposition {
  id: string;
  restaurantId: string;
  restaurantName: string;
  action: DispositionAction;
  items: FoodItem[];
  portions: number;
  reason: string;
  decidedBy: "claude" | "rules";
  /** The app listing, when the action is "sell". */
  listingId?: string;
  /** Food bank, composter or biogas plant that collects it. */
  partnerId?: string;
  /** Chef agent's ideas, when the action is "reuse". */
  recipes?: Recipe[];
  demo?: boolean;
  createdAt: string;
}

/** Organisations that close the loop: food banks take donations, composters and biogas plants take
 * inedible food, and farms grow new produce with the compost. */
export interface Partner {
  id: string;
  name: string;
  kind: "food_bank" | "composter" | "biogas" | "farm";
  lat: number;
  lng: number;
  address: string;
  /** Fictional partner for demos. */
  demo?: boolean;
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
  dispositions: Disposition[];
  partners: Partner[];
}

const empty = (): Data => ({
  restaurants: [],
  messages: [],
  listings: [],
  users: [],
  reservations: [],
  notifications: [],
  dispositions: [],
  partners: [],
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
