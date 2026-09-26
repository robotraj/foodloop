import type { Restaurant } from "../store.js";

/**
 * How the outreach agent talks to restaurants. The prototype uses the simulated inbox;
 * a WhatsApp Business or email channel implements the same interface later.
 */
export interface OutreachChannel {
  name: string;
  /** Real channels (WhatsApp, SMS) may only message restaurants that opted in. */
  requiresOptIn: boolean;
  send(restaurant: Restaurant, text: string): Promise<void>;
}
