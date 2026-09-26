// Server-Sent Events: personal food alerts per user, plus a public live feed
// (listing changes, stats, simulator activity) that every open page can follow.
import type { Response } from "express";
import type { Notification } from "./store.js";

const subscribers = new Map<string, Set<Response>>();
const publicFeed = new Set<Response>();

function open(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

export function subscribe(userId: string, res: Response): void {
  open(res);
  const set = subscribers.get(userId) ?? new Set();
  set.add(res);
  subscribers.set(userId, set);
  res.on("close", () => set.delete(res));
}

export function subscribePublic(res: Response): void {
  open(res);
  publicFeed.add(res);
  res.on("close", () => publicFeed.delete(res));
}

export function push(notification: Notification): void {
  for (const res of subscribers.get(notification.userId) ?? []) {
    res.write(`event: food\ndata: ${JSON.stringify(notification)}\n\n`);
  }
}

export function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of publicFeed) res.write(message);
}

// Keep connections alive through proxies.
setInterval(() => {
  for (const set of [...subscribers.values(), publicFeed]) for (const res of set) res.write(": ping\n\n");
}, 25_000).unref();
