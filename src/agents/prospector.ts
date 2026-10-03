// Agent 7 — Outreach agent (real email).
// Searches real Amsterdam restaurants, drafts a first-contact email for each one with a public email
// address, and queues the drafts for approval in the agent console. Approved drafts are sent by email
// (capped per day), and replies — from the inbound webhook or pasted in the console — go through the
// outreach agent's reply handling, which updates each restaurant's status:
//   ready → draft → contacted → replied / opted_out
import { config } from "../config.js";
import { HttpError } from "../reservations.js";
import { AMSTERDAM_CENTER, distanceKm } from "../geo.js";
import { db, newId, nowIso, save, type OutboxEmail, type Restaurant } from "../store.js";
import type { OutreachChannel } from "../channels/channel.js";
import { simulatedInbox } from "../channels/simulatedInbox.js";
import { DEFAULT_SUBJECT, deliver, emailReplyChannel, emailStatus, isEmail } from "../channels/email.js";
import { findRestaurants } from "./finder.js";
import { draftIntroEmail, handleReply, record, type ReplyResult } from "./outreach.js";

export type OutreachStage = "ready" | "draft" | "contacted" | "replied" | "opted_out" | "failed" | "skipped";

const amsterdamDate = (iso: string | Date) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });

const intros = () => db.outbox.filter((o) => o.kind === "intro");

/** Where a restaurant with an email address is in the real email pipeline. */
export function stageOf(restaurant: Restaurant): OutreachStage | undefined {
  if (!isEmail(restaurant.email)) return undefined;
  const intro = intros().findLast((o) => o.restaurantId === restaurant.id);
  if (!intro) return restaurant.status === "opted_out" ? "opted_out" : "ready";
  if (intro.status === "draft") return "draft";
  if (intro.status === "discarded") return "skipped";
  if (intro.status === "failed") return "failed";
  if (restaurant.status === "opted_out") return "opted_out";
  const replied = db.messages.some((m) => m.restaurantId === restaurant.id && m.direction === "inbound" && m.createdAt >= intro.sentAt!);
  return replied ? "replied" : "contacted";
}

export function introsSentToday(): number {
  const today = amsterdamDate(new Date());
  return intros().filter((o) => o.status === "sent" && o.sentAt && amsterdamDate(o.sentAt) === today).length;
}

/** Restaurants we may email for the first time: a valid address, never drafted or skipped, not opted out. */
function candidates(): Restaurant[] {
  const touched = new Set(intros().map((o) => o.restaurantId));
  return db.restaurants
    .filter((r) => isEmail(r.email) && r.status !== "opted_out" && !touched.has(r.id))
    .sort((a, b) => distanceKm(AMSTERDAM_CENTER, a) - distanceKm(AMSTERDAM_CENTER, b));
}

/** Search (optionally) and draft first-contact emails. Nothing is sent here. */
export async function prepareOutreach(opts: { limit?: number; refresh?: boolean } = {}) {
  // Emails come from OpenStreetMap; Google Places doesn't return email addresses.
  const search = opts.refresh ? await findRestaurants({ source: "osm" }) : undefined;
  const picked = candidates().slice(0, Math.max(1, Math.min(opts.limit ?? 10, 50)));
  const drafted: OutboxEmail[] = [];
  for (const restaurant of picked) {
    const item: OutboxEmail = {
      id: newId(),
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      to: restaurant.email!.trim(),
      subject: DEFAULT_SUBJECT,
      text: await draftIntroEmail(restaurant),
      kind: "intro",
      status: "draft",
      createdAt: nowIso(),
    };
    db.outbox.push(item);
    drafted.push(item);
    save();
  }
  return { search, drafted: drafted.length, remaining: candidates().length };
}

function draft(id: string): OutboxEmail {
  const item = db.outbox.find((o) => o.id === id);
  if (!item || !(item.status === "draft" || item.status === "failed")) throw new HttpError(404, "That draft no longer exists or was already handled");
  return item;
}

export function updateDraft(id: string, changes: { subject?: string; text?: string }): OutboxEmail {
  const item = draft(id);
  if (typeof changes.subject === "string" && changes.subject.trim()) item.subject = changes.subject.trim().slice(0, 200);
  if (typeof changes.text === "string" && changes.text.trim()) item.text = changes.text.trim().slice(0, 5000);
  save();
  return item;
}

export function discardDrafts(ids: string[]): number {
  let discarded = 0;
  for (const item of db.outbox) {
    if (ids.includes(item.id) && (item.status === "draft" || item.status === "failed")) {
      item.status = "discarded";
      discarded++;
    }
  }
  save();
  return discarded;
}

/** Send approved drafts by email, within the daily cap. */
export async function approveAndSend(ids: string[]) {
  const status = emailStatus();
  if (!status.configured) throw new HttpError(400, `Email isn't set up yet: set ${status.missing.join(", ")} in .env`);

  const sent: string[] = [];
  const failed: { restaurant: string; error: string }[] = [];
  let capReached = false;
  for (const id of ids) {
    const item = db.outbox.find((o) => o.id === id && (o.status === "draft" || o.status === "failed") && o.kind === "intro");
    if (!item) continue;
    const restaurant = db.restaurants.find((r) => r.id === item.restaurantId);
    if (!restaurant || restaurant.status === "opted_out") {
      item.status = "discarded";
      continue;
    }
    if (introsSentToday() >= config.outreachDailyCap) {
      capReached = true;
      break;
    }
    try {
      await deliver(item);
      record(restaurant.id, "outbound", item.text);
      restaurant.status = "contacted";
      restaurant.lastContactedAt = item.sentAt;
      sent.push(restaurant.name);
    } catch (err) {
      failed.push({ restaurant: restaurant.name, error: err instanceof Error ? err.message : String(err) });
    }
    save();
  }
  save();
  return { sent, failed, capReached, remainingToday: Math.max(0, config.outreachDailyCap - introsSentToday()) };
}

/** Real email for restaurants we emailed (when email is set up), the simulated inbox otherwise. */
export function channelFor(restaurant: Restaurant): OutreachChannel {
  const emailed = intros().some((o) => o.restaurantId === restaurant.id && o.status === "sent");
  return emailed && emailStatus().configured ? emailReplyChannel : simulatedInbox;
}

// ---------- Inbound email ----------

const addressOf = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value : (value as { email?: string; Email?: string } | undefined)?.email ?? (value as { Email?: string } | undefined)?.Email;
  const match = text?.match(/[^\s<>"]+@[^\s<>"]+/);
  return match?.[0].toLowerCase();
};

/** Drop the quoted original below a reply ("On … wrote:", "Op … schreef …:", "> …"). */
export function stripQuoted(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(On .+ wrote:|Op .+ schreef.*:|-{2,}\s*Original Message|-{2,}\s*Oorspronkelijk bericht|From: .+|Van: .+)\s*$/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim() || text.trim();
}

/**
 * Accepts the common inbound-email webhook shapes (Resend, Postmark, CloudMailin, Mailgun, or plain
 * { from, text }) and treats the email as the restaurant's reply.
 */
export async function handleInboundEmail(body: Record<string, any>): Promise<{ matched: boolean; restaurant?: string; result?: ReplyResult }> {
  const data = body?.data && typeof body.data === "object" ? body.data : body;
  const from = addressOf(data.from ?? data.From ?? data.FromFull ?? data.sender ?? data.envelope?.from);
  const text = [data.StrippedTextReply, data["stripped-text"], data.text, data.TextBody, data.plain, data["body-plain"]].find(
    (v) => typeof v === "string" && v.trim(),
  ) as string | undefined;
  if (!from || !text) throw new HttpError(400, "Expected a sender address and a plain-text body");

  const restaurant = db.restaurants.find((r) => r.email?.trim().toLowerCase() === from);
  if (!restaurant) return { matched: false };
  const result = await handleReply(restaurant.id, stripQuoted(text).slice(0, 5000), { channel: channelFor(restaurant) });
  return { matched: true, restaurant: restaurant.name, result };
}
