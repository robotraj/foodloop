// Agent 2b — Router.
// Sits between outreach and the publisher: for every surplus item it decides the best action
// (sell in the app, donate to a food bank, reuse in tomorrow's menu, compost, or biogas) and
// records the decision so every portion is traceable.
import { z } from "zod";
import { config } from "../config.js";
import { askStructured } from "../llm.js";
import { distanceKm } from "../geo.js";
import { db, newId, nowIso, type Disposition, type DispositionAction, type FoodItem, type Partner, type Restaurant } from "../store.js";
import { suggestRecipes, type Recipe } from "./chef.js";
import type { SurplusReport } from "./outreach.js";

export const ACTIONS = ["sell", "donate", "reuse", "compost", "biogas"] as const;

export interface RouteDecision {
  action: DispositionAction;
  items: FoodItem[];
  reason: string;
  recipes?: Recipe[];
}

export interface Routing {
  decidedBy: "claude" | "rules";
  decisions: RouteDecision[];
}

// Not fit for people: never sell or donate these, whatever the model says.
const INEDIBLE =
  /\b(spoiled|bedorven|mou?ldy|beschimmeld|rotten|rot|expired|over de datum|peels?|schillen|trimmings|scraps|resten|plate waste|bordresten|coffee grounds|koffiedik|frying oil|frituurvet|bones|botten)\b/i;
// Raw or semi-finished ingredients a kitchen can turn into tomorrow's dishes.
const INGREDIENT =
  /\b(bread|brood|loaves|baguettes?|vegetables?|groenten?|fruit|rice|rijst|potato(es)?|aardappel(en)?|herbs|kruiden|dough|deeg|stock|bouillon|cheese|kaas|tomato(es)?|tomaten)\b/i;

const RouterOutput = z.object({
  decisions: z
    .array(
      z.object({
        item_index: z.number().int().describe("0-based index of the item in the list you were given"),
        action: z.enum(ACTIONS),
        reason: z.string().describe("One short sentence a restaurant owner would understand"),
      }),
    )
    .describe("Exactly one decision per item"),
});

const ROUTER_SYSTEM = `You are the routing agent of FoodLoop, an Amsterdam food-surplus app. For each surplus item, choose the best action:
- sell: list it in the app; locals reserve up to ${config.maxPortionsPerListingPerUser} portions each for a small packaging donation. Default for ready-to-eat food with enough pickup time and people nearby.
- donate: give it to a partner food bank. Best for large batches (around ${config.donateMinPortions}+ portions) that the per-person limits would make slow to clear, or when nobody nearby uses the app.
- reuse: the restaurant keeps it and turns it into tomorrow's dishes. Only for raw or semi-finished ingredients (bread, vegetables, rice, dough...) that keep safely overnight.
- compost: not fit for people (spoiled, peels, trimmings, plate waste), or edible food that cannot be collected in time.
- biogas: like compost but for large volumes (around ${config.biogasMinPortions}+ portions or kg), oils and fats.
Food safety comes first: if there is any sign food is spoiled or unsafe, choose compost or biogas. Never invent facts that are not in the reply.`;

const minutesLeft = (report: SurplusReport) => {
  const end = new Date(report.pickup_end).getTime();
  return Number.isNaN(end) ? undefined : Math.round((end - Date.now()) / 60_000);
};

/** App users whose notification radius covers the restaurant (simulated neighbours included). */
const nearbyUsers = (restaurant: Restaurant) => db.users.filter((u) => distanceKm(u, restaurant) <= u.radiusKm).length;

/** Rule-based decision for one item; also the safety floor applied to Claude's decisions. */
function ruleFor(item: FoodItem, report: SurplusReport): Omit<RouteDecision, "items"> {
  if (INEDIBLE.test(item.name)) {
    return item.portions >= config.biogasMinPortions
      ? { action: "biogas", reason: "Not fit for people and a large volume, so it goes to a biogas digester." }
      : { action: "compost", reason: "Not fit for people, so it goes to compost." };
  }
  const left = minutesLeft(report);
  if (left !== undefined && left < config.minSellMinutes) {
    return INGREDIENT.test(item.name)
      ? { action: "reuse", reason: `Only ${Math.max(0, left)} min left to collect; better kept for tomorrow's menu.` }
      : { action: "compost", reason: `Only ${Math.max(0, left)} min left to collect, too little to rescue it safely.` };
  }
  if (item.portions >= config.donateMinPortions) {
    return { action: "donate", reason: `${item.portions} portions is more than app users can clear in time, so a food bank takes it.` };
  }
  return { action: "sell", reason: "Ready to eat with time to collect, so locals can reserve it in the app." };
}

/** Merge per-item decisions that share an action into one decision. */
function group(perItem: { item: FoodItem; action: DispositionAction; reason: string }[]): RouteDecision[] {
  const byAction = new Map<DispositionAction, RouteDecision>();
  for (const { item, action, reason } of perItem) {
    const d = byAction.get(action);
    if (d) {
      d.items.push(item);
      if (!d.reason.includes(reason)) d.reason += ` ${reason}`;
    } else {
      byAction.set(action, { action, items: [item], reason });
    }
  }
  return [...byAction.values()];
}

/** Ask the chef agent for tomorrow's dish from everything marked for reuse. A failure only costs the ideas. */
async function addRecipes(restaurant: Restaurant, routing: Routing): Promise<Routing> {
  const reuse = routing.decisions.find((d) => d.action === "reuse");
  if (reuse) {
    try {
      reuse.recipes = await suggestRecipes(reuse.items, { cuisine: restaurant.cuisine });
    } catch (err) {
      console.error("Chef agent failed:", err);
    }
  }
  return routing;
}

/** Decide what happens to each surplus item in a report. */
export async function routeSurplus(restaurant: Restaurant, report: SurplusReport, replyText: string): Promise<Routing> {
  const items = report.items.filter((i) => i.portions > 0);
  const rules = items.map((item) => ({ item, ...ruleFor(item, report) }));
  if (config.offline) return addRecipes(restaurant, { decidedBy: "rules", decisions: group(rules) });

  const left = minutesLeft(report);
  const out = await askStructured({
    system: ROUTER_SYSTEM,
    schema: RouterOutput,
    effort: "low",
    prompt: [
      `Restaurant: ${restaurant.name}${restaurant.cuisine ? ` (${restaurant.cuisine})` : ""}`,
      `Their reply: "${replyText}"`,
      `Items:\n${items.map((i, n) => `${n}. ${i.portions}x ${i.name}`).join("\n")}`,
      `Dietary: ${report.dietary.join(", ") || "not specified"}`,
      `Minutes left to collect: ${left ?? "unknown (default window of 2 hours)"}`,
      `App users whose alert radius covers this restaurant: ${nearbyUsers(restaurant)}`,
    ].join("\n"),
  });

  const perItem = rules.map((rule, n) => {
    // Safety floor: anything the rules flag as inedible stays out of people's hands.
    if (rule.action === "compost" || rule.action === "biogas") return rule;
    const d = out.decisions.find((x) => x.item_index === n);
    return d ? { item: rule.item, action: d.action, reason: d.reason } : rule;
  });
  return addRecipes(restaurant, { decidedBy: "claude", decisions: group(perItem) });
}

const PARTNER_FOR: Partial<Record<DispositionAction, Partner["kind"]>> = { donate: "food_bank", compost: "composter", biogas: "biogas" };

/** The closest partner that handles this action, if any are registered. */
function nearestPartner(restaurant: Restaurant, action: DispositionAction): Partner | undefined {
  const kind = PARTNER_FOR[action];
  if (!kind) return undefined;
  return db.partners
    .filter((p) => p.kind === kind)
    .sort((a, b) => distanceKm(restaurant, a) - distanceKm(restaurant, b))[0];
}

/** Store the routing so the console and impact numbers can show where every portion went. */
export function recordDispositions(
  restaurant: Restaurant,
  routing: Routing,
  opts: { listingId?: string; demo?: boolean } = {},
): Disposition[] {
  const records = routing.decisions.map((d) => {
    const partner = nearestPartner(restaurant, d.action);
    return {
      id: newId(),
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      action: d.action,
      items: d.items,
      portions: d.items.reduce((s, i) => s + i.portions, 0),
      reason: d.reason,
      decidedBy: routing.decidedBy,
      ...(d.action === "sell" && opts.listingId ? { listingId: opts.listingId } : {}),
      ...(partner ? { partnerId: partner.id } : {}),
      ...(d.recipes?.length ? { recipes: d.recipes } : {}),
      ...(opts.demo ? { demo: true } : {}),
      createdAt: nowIso(),
    };
  });
  db.dispositions.push(...records);
  return records;
}

const list = (items: FoodItem[]) => items.map((i) => `${i.portions}x ${i.name}`).join(", ");

/** The reply to the restaurant, one line per action. */
export function routingMessage(routing: Routing): string {
  const lines = routing.decisions.map((d) => {
    switch (d.action) {
      case "sell":
        return `• ${list(d.items)}: now live on FoodLoop for locals to reserve.`;
      case "donate":
        return `• ${list(d.items)}: logged for a food-bank pickup; we'll confirm the time.`;
      case "reuse":
        return `• ${list(d.items)}: best kept (chilled) for tomorrow's menu rather than given away tonight.${d.recipes?.length ? ` Idea: ${d.recipes.map((r) => r.title).join(" or ")}.` : ""}`;
      case "compost":
        return `• ${list(d.items)}: logged for compost collection.`;
      case "biogas":
        return `• ${list(d.items)}: logged for biogas collection.`;
    }
  });
  return `Thank you! Here's where your surplus goes:\n${lines.join("\n")}`;
}
