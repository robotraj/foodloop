import type { OutreachChannel } from "./channel.js";

/**
 * Nothing leaves the machine: outbound messages are only stored in the conversation log,
 * and restaurant replies are typed in on the admin page (POST /api/restaurants/:id/reply).
 */
export const simulatedInbox: OutreachChannel = {
  name: "simulated-inbox",
  requiresOptIn: false,
  async send() {},
};
