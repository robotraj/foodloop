// Agent 2 — Outreach.
// Contacts restaurants asking whether they have surplus food today, then reads their free-text
// replies and turns them into a structured surplus report for the publisher agent.
import { z } from "zod";
import { config } from "../config.js";
import { askStructured, askText } from "../llm.js";
import { db, newId, nowIso, save, type Restaurant } from "../store.js";
import type { OutreachChannel } from "../channels/channel.js";
import { simulatedInbox } from "../channels/simulatedInbox.js";
import { publishListing, type PublishResult } from "./publisher.js";

const SurplusReport = z.object({
  has_surplus: z.boolean().describe("True if the restaurant says it has food to give away now or later today."),
  items: z
    .array(
      z.object({
        name: z.string().describe("Dish or product, e.g. 'vegetable lasagne'"),
        portions: z.number().int().describe("Number of individual portions; estimate from trays/boxes if needed"),
      }),
    )
    .describe("Every surplus item mentioned. Empty if none."),
  dietary: z.array(z.string()).describe("Dietary tags that apply to ALL items, e.g. vegetarian, vegan, halal. Empty if unknown."),
  pickup_start: z.string().describe("Pickup window start as ISO 8601 with timezone offset. Empty string if not mentioned."),
  pickup_end: z.string().describe("Pickup window end as ISO 8601 with timezone offset. Empty string if not mentioned."),
  needs_follow_up: z.boolean().describe("True if we must ask something before we can publish (e.g. surplus mentioned but no quantity)."),
  follow_up_question: z.string().describe("Short, friendly question to send back. Empty string if none needed."),
  wants_to_stop: z.boolean().describe("True if the restaurant asks not to be contacted again."),
});
export type SurplusReport = z.infer<typeof SurplusReport>;

const OUTREACH_SYSTEM = `You write short outreach messages for FoodLoop, an Amsterdam app that rescues surplus food from restaurants.
Locals reserve the surplus portions at a fair base price and can add an optional tip; the restaurant prevents good food from going to waste.
Write a warm, 3-5 sentence message (WhatsApp tone, no subject line, no hashtags). Ask whether they have any surplus food today, roughly how many portions, and when it could be picked up.
Mention they can reply STOP to never be contacted again. Write in English with a short Dutch greeting. Output only the message text.`;

const PARSE_SYSTEM = `You read restaurant replies for FoodLoop, an Amsterdam food-surplus app, and extract a structured surplus report.
Rules:
- Only report food the restaurant actually offers. Never invent items, quantities or times.
- Convert quantities to individual portions (e.g. "a tray of lasagne, about 8 servings" -> 8).
- Interpret times in the Europe/Amsterdam timezone relative to the current time given. "Tonight after 9" means today 21:00; if no end is given, assume one hour after start.
- If they have surplus but no usable quantity, set needs_follow_up and ask for it. A missing pickup time alone is NOT a reason to follow up.
- Replies may be in Dutch or English.`;

function history(restaurantId: string): string {
  return db.messages
    .filter((m) => m.restaurantId === restaurantId)
    .map((m) => `${m.direction === "outbound" ? "FoodLoop" : "Restaurant"}: ${m.text}`)
    .join("\n");
}

function record(restaurantId: string, direction: "outbound" | "inbound", text: string) {
  db.messages.push({ id: newId(), restaurantId, direction, text, createdAt: nowIso() });
}

async function draftMessage(restaurant: Restaurant): Promise<string> {
  if (config.offline) {
    return `Hoi ${restaurant.name}! This is FoodLoop, an Amsterdam app that makes sure good food doesn't go to waste. Do you have any surplus food today? If so, tell us roughly how many portions and when it can be picked up — locals collect it at a fair base price and can add an optional tip. Reply STOP and we won't contact you again.`;
  }
  return askText({
    system: OUTREACH_SYSTEM,
    prompt: `Restaurant: ${restaurant.name}${restaurant.cuisine ? ` (cuisine: ${restaurant.cuisine})` : ""}\nAddress: ${restaurant.address || "Amsterdam"}`,
  });
}

/** Send the daily "any surplus?" message to one restaurant. */
export async function contactRestaurant(restaurant: Restaurant, channel: OutreachChannel = simulatedInbox): Promise<string> {
  const message = await draftMessage(restaurant);
  await channel.send(restaurant, message);
  record(restaurant.id, "outbound", message);
  restaurant.status = "contacted";
  restaurant.lastContactedAt = nowIso();
  save();
  return message;
}

/** Contact up to `limit` restaurants that haven't been contacted yet. */
export async function runOutreach(opts: { limit?: number; channel?: OutreachChannel } = {}) {
  const channel = opts.channel ?? simulatedInbox;
  const targets = db.restaurants.filter((r) => r.status === "new").slice(0, opts.limit ?? 5);
  const contacted: { restaurant: string; message: string }[] = [];
  for (const restaurant of targets) {
    contacted.push({ restaurant: restaurant.name, message: await contactRestaurant(restaurant, channel) });
  }
  return { channel: channel.name, contacted };
}

async function parseReply(restaurant: Restaurant): Promise<SurplusReport> {
  if (config.offline) return parseReplyOffline(db.messages.filter((m) => m.restaurantId === restaurant.id).at(-1)!.text);

  const now = new Date();
  return askStructured({
    system: PARSE_SYSTEM,
    schema: SurplusReport,
    prompt: [
      `Current time: ${now.toISOString()} (UTC). Local time in Amsterdam: ${now.toLocaleString("en-GB", { timeZone: "Europe/Amsterdam" })}`,
      `Restaurant: ${restaurant.name}`,
      "",
      "Conversation so far (the last message is the new reply):",
      history(restaurant.id),
    ].join("\n"),
  });
}

/** Today's date at hh:mm Amsterdam time, whatever timezone the server runs in. */
function amsterdamToday(h: number, m: number): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), h, m);
  // Amsterdam's UTC offset at that moment (1h in winter, 2h in summer).
  const wall = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "Europe/Amsterdam" }));
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess - (wall.getTime() - utc.getTime()));
}

/** Rough rule-based parser used when Claude isn't configured. Handles replies like "8 portions of lasagne, pickup 21:00-22:00". */
export function parseReplyOffline(text: string): SurplusReport {
  const lower = text.toLowerCase();
  const report: SurplusReport = {
    has_surplus: false,
    items: [],
    dietary: [],
    pickup_start: "",
    pickup_end: "",
    needs_follow_up: false,
    follow_up_question: "",
    wants_to_stop: /\b(stop|unsubscribe|geen interesse|not interested)\b/.test(lower),
  };
  if (report.wants_to_stop) return report;

  for (const m of text.matchAll(/(\d+)\s*(?:x\s*)?(?:portions?|porties?|servings?|pieces?|stuks?)?\s*(?:of|van)?\s*([a-zA-Z][a-zA-Z '-]*?)(?=\s*(?:,|\.|;|\band\b|\ben\b|\bpickup\b|\bophalen\b|\bleft\b|\btoday\b|\bvandaag\b|$))/gi)) {
    const name = m[2].trim();
    if (name && !/^(pm|am|uur|h)$/i.test(name)) report.items.push({ name, portions: Number(m[1]) });
  }
  report.has_surplus = report.items.length > 0 || /\b(yes|ja|we have|hebben)\b/.test(lower);
  if (report.has_surplus && report.items.length === 0) {
    report.needs_follow_up = true;
    report.follow_up_question = "Great, thank you! Roughly how many portions is it, and what dishes?";
  }
  for (const tag of ["vegetarian", "vegan", "halal", "gluten-free"]) if (lower.includes(tag)) report.dietary.push(tag);

  const time = lower.match(/(\d{1,2})[:.](\d{2})\s*(?:-|–|to|until|tot)\s*(\d{1,2})[:.](\d{2})/);
  if (time) {
    const at = (h: string, m: string) => amsterdamToday(Number(h), Number(m)).toISOString();
    report.pickup_start = at(time[1], time[2]);
    report.pickup_end = at(time[3], time[4]);
  }
  return report;
}

export interface ReplyResult {
  report: SurplusReport;
  followUpSent?: string;
  published?: PublishResult;
}

/** Store a restaurant's reply, extract the surplus report, and hand it to the publisher. */
export async function handleReply(
  restaurantId: string,
  text: string,
  opts: { channel?: OutreachChannel; demo?: boolean } = {},
): Promise<ReplyResult> {
  const channel = opts.channel ?? simulatedInbox;
  const restaurant = db.restaurants.find((r) => r.id === restaurantId);
  if (!restaurant) throw new Error("Unknown restaurant");

  record(restaurant.id, "inbound", text);
  restaurant.status = "replied";
  save();

  const report = await parseReply(restaurant);
  const result: ReplyResult = { report };

  if (report.wants_to_stop) {
    restaurant.status = "opted_out";
    const bye = "Understood — we won't contact you again. Thank you!";
    await channel.send(restaurant, bye);
    record(restaurant.id, "outbound", bye);
  } else if (report.needs_follow_up && report.follow_up_question) {
    await channel.send(restaurant, report.follow_up_question);
    record(restaurant.id, "outbound", report.follow_up_question);
    result.followUpSent = report.follow_up_question;
  } else if (report.has_surplus && report.items.some((i) => i.portions > 0)) {
    result.published = await publishListing(restaurant, report, { demo: opts.demo });
    const thanks = `Thank you! Your surplus is now live on FoodLoop (${result.published.listing.totalPortions} portions). Pickup codes will be shown to you at collection.`;
    await channel.send(restaurant, thanks);
    record(restaurant.id, "outbound", thanks);
  }
  save();
  return result;
}
