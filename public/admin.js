const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const adminToken = new URLSearchParams(location.search).get("token") || "";

let overview;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function busy(button, output, fn) {
  button.disabled = true;
  output.textContent = "Working…";
  try {
    output.textContent = await fn();
  } catch (err) {
    output.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
    await load();
  }
}

async function load() {
  overview = await api("/api/admin/overview");
  const s = overview.stats;
  $("stats").innerHTML = [
    ["Restaurants", overview.restaurants.length],
    ["Listings live", overview.listings.filter((l) => l.status === "active").length],
    ["Users", s.users],
    ["Portions rescued", s.portionsRescued],
    ["Donations", `€${s.donations.toFixed(2)}`],
  ]
    .map(([label, value]) => `<div class="stat"><b>${value}</b><span class="muted">${label}</span></div>`)
    .join("");

  const selected = $("restaurant").value;
  const contacted = overview.restaurants.filter((r) => r.messages.length);
  $("restaurant").innerHTML = contacted.length
    ? contacted.map((r) => `<option value="${r.id}">${esc(r.name)} — ${r.status}</option>`).join("")
    : `<option value="">Run outreach first</option>`;
  if (contacted.some((r) => r.id === selected)) $("restaurant").value = selected;
  renderThread();

  const ACTIONS = ["sell", "donate", "reuse", "compost", "biogas"];
  const totals = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const d of overview.dispositions) totals[d.action] += d.portions;
  $("actionTotals").innerHTML = `<p>${ACTIONS.map((a) => `<span class="pill act-${a}">${a} · ${totals[a]}</span>`).join("")}<span class="muted"> portions (last 100 decisions)</span></p>`;
  const partnerName = (id) => overview.partners.find((p) => p.id === id)?.name;
  $("dispositions").innerHTML = overview.dispositions.length
    ? `<table><tr><th>Restaurant</th><th>Items</th><th>Action</th><th>Why</th></tr>${overview.dispositions
        .slice(0, 30)
        .map(
          (d) => `<tr><td>${esc(d.restaurantName)}<div class="muted">${time(d.createdAt)} · ${d.decidedBy}</div></td>
          <td>${d.items.map((i) => `${i.portions}× ${esc(i.name)}`).join(", ")}</td>
          <td><span class="pill act-${d.action}">${d.action}</span>${d.partnerId ? `<div class="muted">${esc(partnerName(d.partnerId))}</div>` : ""}</td>
          <td>${esc(d.reason)}${d.recipes?.length ? `<div class="muted">Recipe: ${d.recipes.map((r) => esc(r.title)).join(", ")}</div>` : ""}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No decisions yet. Send a restaurant reply or start the simulation.</p>`;

  await Promise.all([loadForecast(), loadImpact()]);

  $("listings").innerHTML = overview.listings.length
    ? `<table><tr><th>Listing</th><th>Portions</th><th>Pickup</th><th>Status</th></tr>${overview.listings
        .map(
          (l) => `<tr><td>${esc(l.title)}<div class="muted">${esc(l.restaurantName)} · ${l.items.map((i) => `${i.portions}× ${esc(i.name)}`).join(", ")}</div></td>
          <td>${l.remainingPortions}/${l.totalPortions} <span class="muted">(max ${l.maxPerUser}/person)</span></td>
          <td>${time(l.pickupStart)}–${time(l.pickupEnd)}</td><td>${l.status}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No listings yet.</p>`;
}

async function loadForecast() {
  const rows = await api("/api/admin/forecast");
  $("forecast").innerHTML = rows.length
    ? `<table><tr><th>Restaurant</th><th>Expected today</th><th>Chance</th><th>Based on</th></tr>${rows
        .map(
          (f) => `<tr><td>${esc(f.restaurantName)}</td><td>${f.expectedPortions} portions</td>
          <td>${Math.round(f.chance * 100)}%</td><td class="muted">${esc(f.basis)}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No history yet. Forecasts start once restaurants have replied on an earlier day.</p>`;
}

async function loadImpact() {
  const i = await api("/api/admin/impact");
  $("impactStats").innerHTML = [
    ["Rescued for people", `${i.rescuedKg} kg`],
    ["CO₂e avoided", `${i.co2eAvoidedKg} kg`],
    ["Compost made", `${i.composted.compostKg} kg`],
    ["Biogas", `${i.biogas.m3} m³`],
    ["Compost to farms", `${i.compostToFarmsKg} kg`],
  ]
    .map(([label, value]) => `<div class="stat"><b>${value}</b><span class="muted">${label}</span></div>`)
    .join("");
  const kinds = { food_bank: "Food bank", composter: "Composter", biogas: "Biogas plant", farm: "Farm" };
  $("partners").innerHTML = i.partners.length
    ? `<table><tr><th>Partner</th><th>Role</th><th>Received</th></tr>${i.partners
        .map((p) => `<tr><td>${esc(p.name)}<div class="muted">${esc(p.address)}</div></td><td>${kinds[p.kind]}</td><td>${p.kind === "farm" ? "compost" : `${p.portions} portions`}</td></tr>`)
        .join("")}</table>`
    : `<p class="muted">No partners yet, so donations and compost aren't assigned to anyone. Add the demo partners to see the full loop.</p>`;
}

function renderThread() {
  const r = overview.restaurants.find((x) => x.id === $("restaurant").value);
  $("thread").innerHTML = r
    ? r.messages.map((m) => `<div class="msg ${m.direction}">${esc(m.text)}</div>`).join("")
    : "";
}

$("restaurant").addEventListener("change", renderThread);

$("find").addEventListener("click", (e) =>
  busy(e.target, $("findResult"), async () => {
    const r = await api("/api/agents/finder", { method: "POST", body: { limit: Number($("findLimit").value) || undefined } });
    return `Checked ${r.found} places from OpenStreetMap, added ${r.added} new restaurants.`;
  }),
);

$("seed").addEventListener("click", (e) =>
  busy(e.target, $("findResult"), async () => `Added ${(await api("/api/agents/seed", { method: "POST" })).added} demo restaurants.`),
);

$("outreach").addEventListener("click", (e) =>
  busy(e.target, $("outreachResult"), async () => {
    const r = await api("/api/agents/outreach", { method: "POST", body: { limit: Number($("outreachLimit").value) } });
    return r.contacted.length
      ? `Contacted ${r.contacted.length} restaurant(s) via ${r.channel}: ${r.contacted.map((c) => c.restaurant).join(", ")}`
      : "No uncontacted restaurants left — run the finder first.";
  }),
);

$("smartOutreach").addEventListener("click", (e) =>
  busy(e.target, $("outreachResult"), async () => {
    const r = await api("/api/agents/outreach", { method: "POST", body: { limit: Number($("outreachLimit").value), smart: true } });
    return r.contacted.length
      ? `Contacted ${r.contacted.length} likely-surplus restaurant(s): ${r.contacted.map((c) => c.restaurant).join(", ")}`
      : "The forecast has no restaurants left to contact today (it needs replies from earlier days).";
  }),
);

$("chef").addEventListener("click", (e) =>
  busy(e.target, $("chefResult"), async () => {
    const recipes = await api("/api/agents/chef", { method: "POST", body: { text: $("leftovers").value } });
    $("recipes").innerHTML = recipes
      .map(
        (r) => `<div class="recipe"><h3>${esc(r.title)} <span class="muted">· ${r.minutes} min</span></h3>
        <p class="muted">Uses: ${r.uses.map(esc).join(", ")}${r.allergens.length ? ` · Allergens: ${r.allergens.map(esc).join(", ")}` : ""}</p>
        <ul>${r.ingredients.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <ol>${r.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>`,
      )
      .join("");
    return `${recipes.length} recipe(s)`;
  }),
);

$("seedPartners").addEventListener("click", (e) =>
  busy(e.target, $("partnerResult"), async () => `Added ${(await api("/api/agents/partners/seed", { method: "POST" })).added} demo partner(s).`),
);

$("sendReply").addEventListener("click", (e) =>
  busy(e.target, $("replyResult"), async () => {
    const id = $("restaurant").value;
    const text = $("reply").value.trim();
    if (!id || !text) throw new Error("Pick a restaurant and type a reply");
    const r = await api(`/api/restaurants/${id}/reply`, { method: "POST", body: { text } });
    $("reply").value = "";
    const routed = (r.routing?.decisions ?? []).filter((d) => d.action !== "sell").map((d) => `${d.items.reduce((s, i) => s + i.portions, 0)} → ${d.action}`);
    const extra = routed.length ? ` Router: ${routed.join(", ")}.` : "";
    if (r.published) return `Published "${r.published.listing.title}" and notified ${r.published.notifiedUsers} nearby user(s).${extra}`;
    if (routed.length) return `Nothing listed.${extra}`;
    if (r.followUpSent) return "Asked the restaurant a follow-up question.";
    if (r.report.wants_to_stop) return "Restaurant opted out.";
    return "No surplus reported — nothing published.";
  }),
);

// ---------- Live simulation ----------

let sim;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function renderSim() {
  $("simToggle").textContent = sim.running ? "Pause simulation" : "Start simulation";
  $("simSpeed").value = String(sim.intervalSec);
  $("simInfo").textContent = `${sim.bots} simulated neighbours${sim.usesClaude ? " · uses Claude: each simulated restaurant costs about 3 API calls" : ""}`;
  $("activity").innerHTML = sim.activity.length
    ? sim.activity.map((a) => `<li class="k-${a.kind}"><time>${clock(a.at)}</time><span>${esc(a.text)}</span></li>`).join("")
    : `<li class="muted">No activity yet.</li>`;
}

$("simToggle").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = sim.running ? "Pausing…" : "Starting… (first run fetches restaurants)";
  try {
    sim = await api("/api/simulator", { method: "POST", body: { running: !sim.running, intervalSec: Number($("simSpeed").value) } });
  } catch (err) {
    alert(err.message);
  }
  e.target.disabled = false;
  renderSim();
  load();
});

$("simSpeed").addEventListener("change", async () => {
  if (!sim.running) return;
  sim = await api("/api/simulator", { method: "POST", body: { running: true, intervalSec: Number($("simSpeed").value) } });
  renderSim();
});

$("simClear").addEventListener("click", async () => {
  if (!confirm("Remove all simulated listings, reservations and neighbours? Real restaurants and real users stay.")) return;
  sim = await api("/api/simulator/clear", { method: "POST" });
  renderSim();
  load();
});

let reloadTimer;
function connectLiveFeed() {
  const feed = new EventSource("/api/events");
  feed.onopen = () => $("live").classList.add("on");
  feed.onerror = () => $("live").classList.remove("on");
  feed.addEventListener("activity", (e) => {
    sim.activity.unshift(JSON.parse(e.data));
    sim.activity.length = Math.min(sim.activity.length, 60);
    renderSim();
  });
  feed.addEventListener("simulator", (e) => {
    sim = JSON.parse(e.data);
    renderSim();
  });
  feed.addEventListener("listing", () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 800);
  });
}

(async () => {
  const cfg = await api("/api/config");
  sim = await api("/api/simulator");
  renderSim();
  connectLiveFeed();
  $("mode").textContent = cfg.offline ? "Offline mode (rule-based)" : `AI agents: ${cfg.model}`;
  await load();
})();
