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
    ["Tips", `€${s.tips.toFixed(2)}`],
    ["Revenue", `€${s.revenue.toFixed(2)}`],
  ]
    .map(([label, value]) => `<div class="stat"><b>${value}</b><span class="muted">${label}</span></div>`)
    .join("");

  renderConversationPicker();
  await loadOutreach();

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

// ---------- Outreach agent ----------

const STAGES = {
  ready: { label: "Ready to contact", short: "Ready" },
  draft: { label: "Awaiting approval", short: "Draft" },
  contacted: { label: "Contacted", short: "Contacted" },
  replied: { label: "Replied", short: "Replied" },
  opted_out: { label: "Opted out", short: "Opted out" },
  failed: { label: "Send failed", short: "Failed" },
  skipped: { label: "Skipped", short: "Skipped" },
};
const stagePill = (stage) => (stage ? `<span class="stage st-${stage}">${STAGES[stage].short}</span>` : `<span class="muted">no email</span>`);

// First emails waiting for approval, including ones that failed to send and can be retried.
const awaitingApproval = (o) => o.kind === "intro" && (o.status === "draft" || o.status === "failed");

let outreach;
let stageFilter = "email";
let restaurantPage = 50;
let pinnedRestaurant = "";
const selectedDrafts = new Set();

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 6000);
}

async function loadOutreach() {
  outreach = await api("/api/admin/outreach");
  renderChannel();
  renderPipeline();
  renderDrafts();
  renderRestaurantTable();
  renderSentLog();
}

function renderChannel() {
  const e = outreach.email;
  $("channel").className = `channel ${e.configured ? "ok" : "off"}`;
  $("channel").textContent = e.configured
    ? `Email ready · ${outreach.sentToday}/${outreach.dailyCap} sent today`
    : "Email not set up";
  $("channel").title = e.configured ? `From ${e.from}${e.replyTo ? ` · replies to ${e.replyTo}` : ""}` : "";
  const notice = $("setupNotice");
  notice.classList.toggle("hidden", e.configured);
  if (!e.configured) {
    notice.innerHTML = `You can draft and review emails now. To send them, add <code>${e.missing.join("</code>, <code>")}</code> to <code>.env</code> and restart. See the README section “Outreach agent”.`;
  }
  $("approve").disabled = !e.configured;
  $("approve").title = e.configured ? "" : "Set up email first";
}

function renderPipeline() {
  const s = outreach.stages;
  const steps = ["ready", "draft", "contacted", "replied", "opted_out"];
  $("pipeline").innerHTML =
    steps
      .map(
        (stage, i) => `<button class="step-tile${stageFilter === stage ? " active" : ""}" data-stage="${stage}">
          <b>${s[stage]}</b><span>${STAGES[stage].label}</span>${i < steps.length - 1 ? '<i aria-hidden="true">→</i>' : ""}
        </button>`,
      )
      .join("") +
    `<div class="pipeline-extra muted">${s.failed ? `<button class="link" data-stage="failed">${s.failed} failed</button> · ` : ""}${
      s.skipped ? `<button class="link" data-stage="skipped">${s.skipped} skipped</button> · ` : ""
    }${overview.restaurants.length} restaurants in total, ${overview.restaurants.filter((r) => r.stage).length} with an email address</div>`;
}

$("pipeline").addEventListener("click", (e) => {
  const stage = e.target.closest("[data-stage]")?.dataset.stage;
  if (!stage) return;
  stageFilter = stageFilter === stage ? "email" : stage;
  restaurantPage = 50;
  renderPipeline();
  renderRestaurantTable();
  $("restaurantTable").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

function renderDrafts() {
  const drafts = outreach.outbox.filter(awaitingApproval);
  for (const id of [...selectedDrafts]) if (!drafts.some((d) => d.id === id)) selectedDrafts.delete(id);
  $("draftCount").textContent = drafts.length ? drafts.length : "";
  $("selectAll").checked = drafts.length > 0 && drafts.every((d) => selectedDrafts.has(d.id));
  // Don't redraw while someone is editing a draft.
  if ($("drafts").contains(document.activeElement)) return;
  $("drafts").innerHTML = drafts.length
    ? drafts
        .map(
          (d) => `<article class="draft" data-id="${d.id}">
          <label class="draft-head">
            <input type="checkbox" class="pick" ${selectedDrafts.has(d.id) ? "checked" : ""} />
            <span><b>${esc(d.restaurantName)}</b> <span class="muted">· ${esc(d.to)}</span></span>
          </label>
          ${d.status === "failed" ? `<p class="error small">Couldn't send: ${esc(d.error)}. Fix the problem and approve it again.</p>` : ""}
          <input class="subject" value="${esc(d.subject)}" aria-label="Subject" />
          <textarea class="body" rows="7" aria-label="Email text">${esc(d.text)}</textarea>
          <p class="muted small">A footer with your sender details and “Reply STOP” is added when it's sent.</p>
        </article>`,
        )
        .join("")
    : `<p class="muted">No drafts waiting. Run the outreach agent to draft emails.</p>`;
}

$("drafts").addEventListener("change", async (e) => {
  const card = e.target.closest(".draft");
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains("pick")) {
    e.target.checked ? selectedDrafts.add(id) : selectedDrafts.delete(id);
    renderDrafts();
    return;
  }
  try {
    await api(`/api/outbox/${id}`, {
      method: "PATCH",
      body: { subject: card.querySelector(".subject").value, text: card.querySelector(".body").value },
    });
    const item = outreach.outbox.find((o) => o.id === id);
    if (item) Object.assign(item, { subject: card.querySelector(".subject").value, text: card.querySelector(".body").value });
    toast("Draft saved");
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
});

$("selectAll").addEventListener("change", (e) => {
  const drafts = outreach.outbox.filter(awaitingApproval);
  for (const d of drafts) e.target.checked ? selectedDrafts.add(d.id) : selectedDrafts.delete(d.id);
  $("drafts").querySelectorAll(".pick").forEach((box) => (box.checked = e.target.checked));
  renderDrafts();
});

$("approve").addEventListener("click", (e) => {
  const ids = [...selectedDrafts];
  if (!ids.length) return ($("approveResult").textContent = "Select the drafts you want to send.");
  if (!confirm(`Send ${ids.length} email(s) to real restaurants now?`)) return;
  return busy(e.target, $("approveResult"), async () => {
    const r = await api("/api/outbox/approve", { method: "POST", body: { ids } });
    selectedDrafts.clear();
    const parts = [`Sent ${r.sent.length} email(s).`];
    if (r.failed.length) parts.push(`Failed: ${r.failed.map((f) => `${f.restaurant} (${f.error})`).join("; ")}.`);
    if (r.capReached) parts.push("Daily limit reached: the rest stay as drafts for tomorrow.");
    parts.push(`${r.remainingToday} more can go out today.`);
    return parts.join(" ");
  });
});

$("discard").addEventListener("click", (e) => {
  const ids = [...selectedDrafts];
  if (!ids.length) return ($("approveResult").textContent = "Select the drafts you want to discard.");
  return busy(e.target, $("approveResult"), async () => {
    const r = await api("/api/outbox/discard", { method: "POST", body: { ids } });
    selectedDrafts.clear();
    return `Discarded ${r.discarded} draft(s). Those restaurants are skipped from now on.`;
  });
});

$("prospect").addEventListener("click", (e) =>
  busy(e.target, $("prospectResult"), async () => {
    const refresh = $("prospectRefresh").checked;
    if (refresh) $("prospectResult").textContent = "Searching OpenStreetMap (this can take a minute)…";
    const r = await api("/api/agents/prospector", { method: "POST", body: { limit: Number($("prospectLimit").value) || 10, refresh } });
    const found = r.search ? `Searched OpenStreetMap: ${r.search.found} places, ${r.search.added} new. ` : "";
    return r.drafted
      ? `${found}Drafted ${r.drafted} email(s). Review them below. ${r.remaining} more restaurants are ready to contact.`
      : `${found}No restaurants left to contact: every restaurant with an email address has been drafted, contacted or skipped.`;
  }),
);

function renderRestaurantTable() {
  const counts = { email: 0, all: overview.restaurants.length };
  for (const r of overview.restaurants) if (r.stage) counts.email++;
  const filters = [
    ["email", "With email"],
    ...Object.entries(STAGES).map(([k, v]) => [k, v.short]),
    ["all", "All restaurants"],
  ];
  $("stageFilter").innerHTML = filters
    .map(([k, label]) => `<button class="chip${stageFilter === k ? " active" : ""}" data-filter="${k}">${label}${k in outreach.stages ? ` · ${outreach.stages[k]}` : k in counts ? ` · ${counts[k]}` : ""}</button>`)
    .join("");

  const q = $("restaurantSearch").value.trim().toLowerCase();
  const rows = overview.restaurants.filter((r) => {
    if (stageFilter === "email" ? !r.stage : stageFilter !== "all" && r.stage !== stageFilter) return false;
    return !q || [r.name, r.email, r.address].some((v) => v?.toLowerCase().includes(q));
  });
  $("restaurantTable").innerHTML = rows.length
    ? `<table><tr><th>Restaurant</th><th>Email</th><th>Status</th><th>Last contact</th><th></th></tr>${rows
        .slice(0, restaurantPage)
        .map(
          (r) => `<tr><td>${esc(r.name)}<div class="muted">${esc(r.address || "")}</div></td>
          <td class="muted">${esc(r.email || "")}</td>
          <td>${stagePill(r.stage)}</td>
          <td class="muted">${r.lastContactedAt ? new Date(r.lastContactedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : ""}</td>
          <td><button class="link" data-open="${r.id}">Conversation</button></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No restaurants match.</p>`;
  $("moreRestaurants").classList.toggle("hidden", rows.length <= restaurantPage);
  $("moreRestaurants").textContent = `Show more (${rows.length - restaurantPage} left)`;
}

$("stageFilter").addEventListener("click", (e) => {
  const filter = e.target.closest("[data-filter]")?.dataset.filter;
  if (!filter) return;
  stageFilter = filter;
  restaurantPage = 50;
  renderPipeline();
  renderRestaurantTable();
});
$("restaurantSearch").addEventListener("input", () => {
  restaurantPage = 50;
  renderRestaurantTable();
});
$("moreRestaurants").addEventListener("click", () => {
  restaurantPage += 100;
  renderRestaurantTable();
});
$("restaurantTable").addEventListener("click", (e) => {
  const id = e.target.closest("[data-open]")?.dataset.open;
  if (!id) return;
  pinnedRestaurant = id;
  renderConversationPicker(id);
  $("restaurant").scrollIntoView({ behavior: "smooth", block: "center" });
});

function renderSentLog() {
  const items = outreach.outbox.filter((o) => o.status !== "draft").slice(0, 50);
  $("sentLog").innerHTML = items.length
    ? `<table><tr><th>When</th><th>Restaurant</th><th>Type</th><th>Status</th></tr>${items
        .map(
          (o) => `<tr><td class="muted">${new Date(o.sentAt || o.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</td>
          <td>${esc(o.restaurantName)}<div class="muted">${esc(o.to)}</div></td>
          <td>${o.kind === "intro" ? "First email" : "Reply"}</td>
          <td><span class="stage st-${o.status === "sent" ? "contacted" : o.status === "failed" ? "failed" : "skipped"}">${o.status}</span>${o.error ? `<div class="error">${esc(o.error)}</div>` : ""}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">Nothing sent yet.</p>`;
}

// ---------- Conversation ----------

function renderConversationPicker(select) {
  const selected = select || $("restaurant").value;
  const list = overview.restaurants.filter((r) => r.messages.length || r.id === pinnedRestaurant);
  $("restaurant").innerHTML = list.length
    ? list.map((r) => `<option value="${r.id}">${esc(r.name)} — ${r.stage ? STAGES[r.stage].short : r.status}</option>`).join("")
    : `<option value="">No conversations yet</option>`;
  if (list.some((r) => r.id === selected)) $("restaurant").value = selected;
  renderThread();
}

function renderThread() {
  const r = overview.restaurants.find((x) => x.id === $("restaurant").value);
  $("thread").innerHTML = r
    ? r.messages.length
      ? r.messages.map((m) => `<div class="msg ${m.direction}">${esc(m.text)}</div>`).join("")
      : `<p class="muted">No messages with ${esc(r.name)} yet.</p>`
    : "";
}

$("restaurant").addEventListener("change", renderThread);

$("find").addEventListener("click", (e) =>
  busy(e.target, $("findResult"), async () => {
    const r = await api("/api/agents/finder", {
      method: "POST",
      body: { limit: Number($("findLimit").value) || undefined, source: $("findSource").value || undefined },
    });
    return r.source === "google"
      ? `Checked ${r.found} places from Google Places (${r.requests} API requests), added ${r.added} new restaurants.`
      : `Checked ${r.found} places from OpenStreetMap, added ${r.added} new restaurants.`;
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
