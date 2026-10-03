// Closing the loop: where rescued and wasted food went, what it saved, and how much compost made it
// back to farms that grow new food. Weights and emission factors are rough estimates (see config).
import { config } from "./config.js";
import { db, newId, nowIso, type DispositionAction, type Partner } from "./store.js";

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

export function impact() {
  const reserved = new Map<string, number>();
  for (const r of db.reservations) {
    if (r.status !== "cancelled") reserved.set(r.listingId, (reserved.get(r.listingId) ?? 0) + r.portions);
  }

  const byAction: Record<DispositionAction, number> = { sell: 0, donate: 0, reuse: 0, compost: 0, biogas: 0 };
  for (const d of db.dispositions) byAction[d.action] += d.portions;

  // Listed food only counts as rescued once someone actually reserved it.
  const sold = db.dispositions.reduce((s, d) => s + (d.listingId ? Math.min(reserved.get(d.listingId) ?? 0, d.portions) : 0), 0);
  const rescuedPortions = sold + byAction.donate + byAction.reuse;
  const kg = (portions: number) => portions * config.kgPerPortion;

  const compostKg = kg(byAction.compost) * config.compostYield;
  const farms = db.partners.filter((p) => p.kind === "farm");

  const partners = db.partners.map((p) => ({
    ...p,
    portions: db.dispositions.filter((d) => d.partnerId === p.id).reduce((s, d) => s + d.portions, 0),
  }));

  return {
    portionsByAction: byAction,
    soldPortions: sold,
    rescuedPortions,
    rescuedKg: round(kg(rescuedPortions)),
    co2eAvoidedKg: round(kg(rescuedPortions) * config.co2ePerKgRescued),
    composted: { inputKg: round(kg(byAction.compost)), compostKg: round(compostKg) },
    biogas: { inputKg: round(kg(byAction.biogas)), m3: round(kg(byAction.biogas) * config.biogasM3PerKg) },
    // Compost goes from the composter to partner farms, which grow produce for restaurants again.
    compostToFarmsKg: farms.length ? round(compostKg) : 0,
    farms: farms.map((f) => f.name),
    partners,
    assumptions: {
      kgPerPortion: config.kgPerPortion,
      co2ePerKgRescued: config.co2ePerKgRescued,
      compostYield: config.compostYield,
      biogasM3PerKg: config.biogasM3PerKg,
    },
  };
}

/** Restaurants whose inedible waste went to a composter or biogas plant instead of the bin. */
export function loopRestaurants(): Set<string> {
  return new Set(db.dispositions.filter((d) => (d.action === "compost" || d.action === "biogas") && d.partnerId).map((d) => d.restaurantId));
}

const DEMO_PARTNERS: Omit<Partner, "id" | "createdAt">[] = [
  { name: "Buurtvoedselbank West (demo)", kind: "food_bank", lat: 52.3708, lng: 4.8578, address: "Bos en Lommer, Amsterdam" },
  { name: "Buurtvoedselbank Zuidoost (demo)", kind: "food_bank", lat: 52.3127, lng: 4.9717, address: "Bijlmer, Amsterdam" },
  { name: "Stadscompost Noord (demo)", kind: "composter", lat: 52.3934, lng: 4.9211, address: "Buiksloterham, Amsterdam" },
  { name: "Vergister Havengebied (demo)", kind: "biogas", lat: 52.4012, lng: 4.8323, address: "Havengebied, Amsterdam" },
  { name: "Stadsboerderij Oost (demo)", kind: "farm", lat: 52.3556, lng: 4.9608, address: "Watergraafsmeer, Amsterdam" },
];

/** Add fictional partners so the full loop can be demoed. Returns how many were added. */
export function seedDemoPartners(): number {
  let added = 0;
  for (const p of DEMO_PARTNERS) {
    if (db.partners.some((x) => x.name === p.name)) continue;
    db.partners.push({ ...p, id: newId(), demo: true, createdAt: nowIso() });
    added++;
  }
  return added;
}
