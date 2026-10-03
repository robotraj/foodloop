import { config } from "../config.js";
import { db, newId, nowIso, type OutboxEmail, type Restaurant } from "../store.js";
import type { OutreachChannel } from "./channel.js";

/**
 * Real email through the Resend API. Restaurant replies come back either through the inbound webhook
 * (POST /api/inbound/email) or are pasted into the agent console.
 */

export const DEFAULT_SUBJECT = "Surplus food today? · FoodLoop Amsterdam";

export function emailStatus() {
  const missing = [
    !config.resendApiKey && "RESEND_API_KEY",
    !config.outreachFrom && "OUTREACH_FROM_EMAIL",
    !config.outreachSenderInfo && "OUTREACH_SENDER_INFO",
  ].filter(Boolean) as string[];
  return { configured: missing.length === 0, missing, from: config.outreachFrom ?? null, replyTo: config.outreachReplyTo ?? null };
}

export const isEmail = (value?: string) => !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** Every email says who sent it and how to stop further emails. */
function withFooter(text: string): string {
  return `${text.trim()}\n\n--\n${config.outreachSenderInfo}\nReply STOP and we won't email you again.`;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<string> {
  const status = emailStatus();
  if (!status.configured) throw new Error(`Email isn't set up yet: set ${status.missing.join(", ")} in .env`);
  const replyTo = config.outreachReplyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.outreachFrom,
      to: [to.trim()],
      subject,
      text: withFooter(text),
      ...(replyTo ? { reply_to: replyTo } : {}),
      headers: replyTo ? { "List-Unsubscribe": `<mailto:${replyTo}?subject=STOP>` } : undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${data.message ?? "unknown error"}`);
  return data.id ?? "";
}

/** Send an outbox email and record the result on it. */
export async function deliver(item: OutboxEmail): Promise<void> {
  try {
    item.providerId = await sendEmail(item.to, item.subject, item.text);
    item.status = "sent";
    item.sentAt = nowIso();
    item.error = undefined;
  } catch (err) {
    item.status = "failed";
    item.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Channel for answers in a conversation the restaurant started by replying (follow-up questions,
 * thank-yous, opt-out confirmations). These go out straight away and are logged in the outbox.
 */
export const emailReplyChannel: OutreachChannel = {
  name: "email",
  requiresOptIn: false,
  async send(restaurant: Restaurant, text: string) {
    if (!isEmail(restaurant.email)) throw new Error(`${restaurant.name} has no email address`);
    const item: OutboxEmail = {
      id: newId(),
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      to: restaurant.email!,
      subject: `Re: ${DEFAULT_SUBJECT}`,
      text,
      kind: "reply",
      status: "draft",
      createdAt: nowIso(),
    };
    db.outbox.push(item);
    // A failed send is kept in the outbox (status "failed") and doesn't abort the reply handling:
    // the listing may already be published, and a webhook retry would publish it twice.
    await deliver(item).catch(() => {});
  },
};
