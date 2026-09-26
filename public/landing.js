const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euro = (n) => `€${Number(n).toFixed(2)}`;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let cfg = {
  maxPortionsPerListingPerUser: 2,
  maxReservationsPerDayPerUser: 2,
  basePricePerPortion: 2.5,
  center: { lat: 52.3731, lng: 4.8926 },
};

// ---------- Live stats ----------

function countUp(el, target) {
  if (reducedMotion || document.hidden || target === 0) return (el.textContent = target.toLocaleString());
  const from = Number(el.textContent.replace(/\D/g, "")) || 0;
  if (from === target) return;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 1200);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function loadStats() {
  try {
    const stats = await api("/api/stats");
    document.querySelectorAll("[data-stat]").forEach((el) => countUp(el, stats[el.dataset.stat] ?? 0));
  } catch {
    // Stats are decorative; leave the dashes.
  }
}

// ---------- Phone mock: rotating alerts ----------

const sampleAlerts = [
  { title: "Vegetarian lasagne", place: "Jordaan · 0.4 km", meta: "6 portions · pickup 21:00–22:00" },
  { title: "Sourdough & croissants", place: "De Pijp · 0.8 km", meta: "12 portions · pickup 18:30–19:30" },
  { title: "Dal & rice", place: "Oost · 1.1 km", meta: "5 portions · pickup 22:00–22:45" },
  { title: "Noodle boxes", place: "Noord · 1.6 km", meta: "8 portions · pickup 21:30–22:30" },
  { title: "Stamppot", place: "Centrum · 0.3 km", meta: "4 portions · pickup 20:00–21:00" },
];

const feedEl = () => $("phoneFeed");

function showNote(a) {
  const note = document.createElement("div");
  note.className = "note";
  note.innerHTML = `<span class="tag">${a.live ? "Live now" : "New food nearby"}</span><b>${esc(a.title)}</b>${esc(a.place)}<div class="meta">${esc(a.meta)}</div>`;
  feedEl().prepend(note);
  while (feedEl().children.length > 4) feedEl().lastElementChild.remove();
}

const toAlert = (l) => ({
  title: l.items?.map((i) => i.name).join(" & ") || l.title,
  place: `${l.restaurantName}${l.distanceKm !== undefined ? ` · ${l.distanceKm} km` : ""}`,
  meta: `${l.remainingPortions} portions · pickup ${time(l.pickupStart)}–${time(l.pickupEnd)}`,
  live: true,
});

let liveAlerts = [];
const seen = new Set();

async function startPhone() {
  try {
    const live = await api(`/api/listings?lat=${cfg.center.lat}&lng=${cfg.center.lng}&radiusKm=10`);
    live.forEach((l) => seen.add(l.id));
    liveAlerts = live.slice(0, 6).map(toAlert);
  } catch {}

  let i = 0;
  const next = () => {
    const pool = liveAlerts.length ? liveAlerts : sampleAlerts;
    showNote(pool[i++ % pool.length]);
  };
  next();
  next();
  if (!reducedMotion) setInterval(next, 4000);
}

// Live feed: new listings pop onto the phone and the counters update.
function connectLiveFeed() {
  let statsTimer;
  const feed = new EventSource("/api/events");
  feed.addEventListener("listing", (e) => {
    const l = JSON.parse(e.data);
    if (l && l.status === "active" && !seen.has(l.id)) {
      seen.add(l.id);
      const alert = toAlert(l);
      liveAlerts.unshift(alert);
      liveAlerts.length = Math.min(liveAlerts.length, 6);
      showNote(alert);
    }
    clearTimeout(statsTimer);
    statsTimer = setTimeout(loadStats, 600);
  });
}

// ---------- Food near you ----------

let radius = 2;
document.querySelectorAll("#near .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    radius = Number(chip.dataset.radius);
    document.querySelectorAll("#near .chip").forEach((c) => c.setAttribute("aria-checked", String(c === chip)));
  }),
);

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const position = { lat: p.coords.latitude, lng: p.coords.longitude };
        const latDistance = (position.lat - cfg.center.lat) * 111;
        const lngDistance = (position.lng - cfg.center.lng) * 111 * Math.cos((cfg.center.lat * Math.PI) / 180);
        const outsideDemoArea = Math.hypot(latDistance, lngDistance) > 25;
        resolve(cfg.offline && outsideDemoArea ? null : position);
      },
      () => resolve(null),
      { timeout: 8000 },
    );
  });
}

$("checkNear").addEventListener("click", async (e) => {
  const out = $("nearResult");
  e.target.disabled = true;
  out.innerHTML = `<p class="muted typing">Looking around you</p>`;
  const pos = await getPosition();
  const where = pos ?? cfg.center;
  try {
    const listings = await api(`/api/listings?lat=${where.lat}&lng=${where.lng}&radiusKm=${radius}`);
    const note = pos ? "" : `<p class="muted small">We couldn't get your location, so this is around central Amsterdam.</p>`;
    out.innerHTML = listings.length
      ? `<div class="near-count">${listings.length}</div>
         <p>listing${listings.length === 1 ? "" : "s"} within ${radius} km right now</p>
         ${listings
           .slice(0, 3)
           .map(
             (l) => `<div class="mini"><div><strong>${esc(l.title)}</strong><span class="muted">${esc(l.restaurantName)} · pickup ${time(l.pickupStart)}–${time(l.pickupEnd)} · ${l.remainingPortions} left</span></div><span class="dist">${l.distanceKm} km</span></div>`,
           )
           .join("")}
         ${note}<p><a class="btn btn-small" href="app.html">Reserve in the app</a></p>`
      : `<div class="near-count">0</div>
         <p>Nothing within ${radius} km at the moment. Most food appears in the evening.</p>
         ${note}<p><a class="btn btn-small" href="app.html">Get alerted when it does</a></p>`;
  } catch (err) {
    out.innerHTML = `<p class="muted">Couldn't check right now (${esc(err.message)}).</p>`;
  } finally {
    e.target.disabled = false;
  }
});

// ---------- Agent demo ----------

document.querySelectorAll("#samples .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $("demoText").value = chip.dataset.text;
    document.querySelectorAll("#samples .chip").forEach((c) => c.classList.toggle("active", c === chip));
  }),
);

const stage = (name) => document.querySelector(`#pipeline [data-stage="${name}"]`);

async function runStage(name, render) {
  const li = stage(name);
  li.classList.add("active");
  li.querySelector(".stage-body").innerHTML = `<span class="muted typing">Working</span>`;
  await sleep(reducedMotion ? 0 : 700);
  li.querySelector(".stage-body").innerHTML = render();
  li.classList.remove("active");
  li.classList.add("done");
}

$("runDemo").addEventListener("click", async (e) => {
  const text = $("demoText").value.trim();
  if (!text) return $("demoText").focus();
  e.target.disabled = true;
  document.querySelectorAll("#pipeline li").forEach((li) => {
    li.classList.remove("done", "active");
    li.querySelector(".stage-body").innerHTML = "";
  });

  try {
    const r = await api("/api/demo/parse", { method: "POST", body: { text } });
    const portions = r.items.reduce((s, i) => s + i.portions, 0);
    const pickup = r.pickup_start ? `${time(r.pickup_start)}–${time(r.pickup_end)}` : "next 2 hours (default)";

    await runStage("read", () => {
      const facts = [
        ["Surplus", r.has_surplus ? "yes" : "no"],
        ...r.items.map((i) => ["Item", `${i.portions}× ${i.name}`]),
        ...(r.dietary.length ? [["Dietary", r.dietary.join(", ")]] : []),
        ...(r.pickup_start ? [["Pickup", pickup]] : []),
        ...(r.wants_to_stop ? [["Opt-out", "yes"]] : []),
      ];
      return `<div class="kv">${facts.map(([k, v]) => `<span><b>${k}</b>${esc(v)}</span>`).join("")}</div>`;
    });

    let publish = false;
    await runStage("decide", () => {
      if (r.wants_to_stop) return "Marks the restaurant as opted out and never contacts it again.";
      if (r.needs_follow_up) return `Sends a follow-up: <em>“${esc(r.follow_up_question)}”</em>`;
      if (r.has_surplus && portions > 0) {
        publish = true;
        return `Hands ${portions} portions to the publisher.`;
      }
      return "Thanks the restaurant; nothing to publish today.";
    });

    await runStage("publish", () => {
      if (!publish) return `<span class="muted">Nothing posted this time.</span>`;
      const maxPer = Math.max(1, Math.min(cfg.maxPortionsPerListingPerUser, Math.ceil(portions / 2)));
      return `<div class="listing-preview">
          <strong>${esc(r.items.map((i) => i.name).join(" & "))}</strong>
          <div class="muted small">${portions} portions · pickup ${esc(pickup)} · max ${maxPer} per person</div>
        </div>
        <p class="small" style="margin:8px 0 0">Alert sent to everyone whose radius covers this restaurant.</p>`;
    });
  } catch (err) {
    stage("read").querySelector(".stage-body").textContent = `Demo unavailable: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});

// ---------- Price and tip calculator ----------

function updateCalc() {
  const portions = Number($("portions").value);
  const extra = Number($("extra").value);
  const base = cfg.basePricePerPortion * portions;
  $("portionsOut").textContent = portions;
  $("extraOut").textContent = euro(extra);
  $("packOut").textContent = euro(base);
  $("extraOut2").textContent = euro(extra);
  $("totalOut").textContent = euro(base + extra);
  const [p, a, x] = $("bar").children;
  p.style.flexGrow = base;
  a.style.flexGrow = 0;
  x.style.flexGrow = extra;
}
$("portions").addEventListener("input", updateCalc);
$("extra").addEventListener("input", updateCalc);

function renderRules() {
  $("rules").innerHTML = [
    `Up to ${cfg.maxPortionsPerListingPerUser} portions per listing, so there's enough to go round`,
    `Food from up to ${cfg.maxReservationsPerDayPerUser} restaurants per day`,
    `Base price: ${euro(cfg.basePricePerPortion)} per portion, with an optional tip`,
    "Cancel anytime and your portions go back to others",
  ]
    .map((r) => `<li>${esc(r)}</li>`)
    .join("");
}

// ---------- Init ----------

(async () => {
  try {
    cfg = { ...cfg, ...(await api("/api/config")) };
  } catch {}
  $("portions").max = String(cfg.maxPortionsPerListingPerUser);
  renderRules();
  updateCalc();
  loadStats();
  Sunflower.autoBloom();
  startPhone();
  connectLiveFeed();
})();
