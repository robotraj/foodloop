const $ = (id) => document.getElementById(id);
const euro = (n) => `€${Number(n).toFixed(2)}`;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeWebsite = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};

let cfg;
let user;
let events;

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

const basePrice = (portions) => Math.round(cfg.basePricePerPortion * portions * 100) / 100;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 6000);
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(cfg.center);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const position = { lat: p.coords.latitude, lng: p.coords.longitude };
        const latDistance = (position.lat - cfg.center.lat) * 111;
        const lngDistance = (position.lng - cfg.center.lng) * 111 * Math.cos((cfg.center.lat * Math.PI) / 180);
        const outsideDemoArea = Math.hypot(latDistance, lngDistance) > 25;
        resolve(cfg.offline && outsideDemoArea ? cfg.center : position);
      },
      () => resolve(cfg.center),
      { timeout: 8000 },
    );
  });
}

function showApp() {
  $("signup").classList.add("hidden");
  ["settings", "feed", "restaurantsSection", "mine"].forEach((id) => $(id).classList.remove("hidden"));
  $("whoami").textContent = `Hi ${user.name}`;
  $("radius2").value = String(user.radiusKm);
  $("locationLabel").textContent = `Location ${user.lat.toFixed(3)}, ${user.lng.toFixed(3)} · alerts within ${user.radiusKm} km`;
  $("limits").textContent =
    `Fair-share rules: max ${cfg.maxPortionsPerListingPerUser} portions per listing and ${cfg.maxReservationsPerDayPerUser} listings per day. ` +
    `Base price: ${euro(cfg.basePricePerPortion)} per portion. Tips are optional.`;
  connectEvents();
  refresh();
}

// Public live feed: refresh when any listing appears or changes (portions reserved by others, expiry…).
let liveFeed;
let refreshTimer;
function connectLiveFeed() {
  liveFeed?.close();
  liveFeed = new EventSource("/api/events");
  const dot = $("live");
  liveFeed.onopen = () => dot.classList.add("on");
  liveFeed.onerror = () => dot.classList.remove("on");
  liveFeed.addEventListener("listing", () => {
    if (!user) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400);
  });
}

function connectEvents() {
  events?.close();
  events = new EventSource(`/api/users/${user.id}/events`);
  events.addEventListener("food", (e) => {
    const n = JSON.parse(e.data);
    toast(`New food nearby: ${n.text}`);
    if ("Notification" in window && Notification.permission === "granted") new Notification("FoodLoop", { body: n.text });
    refresh();
  });
}

async function refresh() {
  const [listings, restaurants, reservations] = await Promise.all([
    api(`/api/listings?lat=${user.lat}&lng=${user.lng}&radiusKm=${Math.max(user.radiusKm, 10)}`),
    api(`/api/restaurants/nearby?lat=${user.lat}&lng=${user.lng}&radiusKm=${Math.max(user.radiusKm, 10)}`),
    api(`/api/users/${user.id}/reservations`),
  ]);
  renderListings(listings);
  renderRestaurants(restaurants);
  renderReservations(reservations);
}

let seenListings = null;

function renderListings(listings) {
  // Keep what the user already chose/typed when the list refreshes live.
  const kept = {};
  for (const card of $("listings").querySelectorAll(".listing")) {
    kept[card.dataset.id] = {
      portions: card.querySelector(".portions")?.value,
      tip: card.querySelector(".tip")?.value,
      error: card.querySelector(".error")?.textContent,
    };
  }
  const focused = document.activeElement?.closest?.(".listing")?.dataset.id;
  $("empty").classList.toggle("hidden", listings.length > 0);
  $("listings").innerHTML = listings
    .map((l) => {
      const max = Math.min(l.maxPerUser, l.remainingPortions);
      const options = Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
      return `
      <article class="card listing" data-id="${l.id}">
        ${l.demo ? `<span class="pill test" title="Real restaurant, simulated surplus for testing">Test data</span>` : ""}
        ${l.closesLoop ? `<span class="pill loop" title="This restaurant composts or digests its inedible food waste with a FoodLoop partner">Closes the loop</span>` : ""}
        <h3>${esc(l.title)}</h3>
        <div class="muted">${esc(l.restaurantName)} · ${l.distanceKm} km</div>
        <p>${esc(l.description)}</p>
        <div>${l.items.map((i) => `<span class="pill">${i.portions}× ${esc(i.name)}</span>`).join("")}
             ${l.dietary.map((d) => `<span class="pill">${esc(d)}</span>`).join("")}</div>
        <div class="meta">Pickup ${time(l.pickupStart)}–${time(l.pickupEnd)} · ${esc(l.address || "")}<br>
          ${l.remainingPortions} of ${l.totalPortions} portions left · max ${l.maxPerUser} per person</div>
        <div class="row">
          <label class="muted">Portions <select class="portions">${options}</select></label>
          <label class="muted">Tip € <input class="tip" type="number" min="0" step="0.5" style="width:80px" value="0.00" /></label>
          <button class="reserve">Reserve</button>
        </div>
        <p class="error"></p>
      </article>`;
    })
    .join("");

  for (const card of $("listings").querySelectorAll(".listing")) {
    const k = kept[card.dataset.id];
    if (k) {
      const sel = card.querySelector(".portions");
      if (k.portions && [...sel.options].some((o) => o.value === k.portions)) sel.value = k.portions;
      if (k.tip) card.querySelector(".tip").value = k.tip;
      card.querySelector(".error").textContent = k.error || "";
    }
    if (seenListings && !seenListings.has(card.dataset.id)) card.classList.add("flash");
    if (card.dataset.id === focused) card.querySelector(".tip").focus();
  }
  seenListings = new Set(listings.map((l) => l.id));
}

function renderRestaurants(restaurants) {
  $("restaurantsEmpty").classList.toggle("hidden", restaurants.length > 0);
  $("restaurants").innerHTML = restaurants
    .map((restaurant) => {
      const website = safeWebsite(restaurant.website);
      return `<article class="card">
        <h3>${esc(restaurant.name)}</h3>
        <div class="muted">${restaurant.distanceKm} km · ${esc(restaurant.cuisine || "Restaurant")}</div>
        <p class="meta">${esc(restaurant.address || "Address unavailable")}</p>
        ${restaurant.phone ? `<div><a href="tel:${encodeURIComponent(restaurant.phone)}">${esc(restaurant.phone)}</a></div>` : ""}
        ${restaurant.email ? `<div><a href="mailto:${encodeURIComponent(restaurant.email)}">${esc(restaurant.email)}</a></div>` : ""}
        ${website ? `<div><a href="${esc(website)}" target="_blank" rel="noreferrer">Website</a></div>` : ""}
      </article>`;
    })
    .join("");
}

function renderReservations(list) {
  $("reservations").innerHTML = list.length
    ? `<table><tr><th>Food</th><th>Portions</th><th>Base price</th><th>Tip</th><th>Total</th><th>Pickup code</th><th></th></tr>${list
        .map(
          (r) => `<tr>
            <td>${esc(r.listing?.title)}<div class="muted">${esc(r.listing?.restaurantName)} · ${r.listing ? `${time(r.listing.pickupStart)}–${time(r.listing.pickupEnd)}` : ""}</div></td>
            <td>${r.portions}</td><td>${euro(r.basePrice)}</td><td>${euro(r.tip)}</td><td>${euro(r.total)}</td>
            <td>${r.status === "reserved" ? `<span class="code">${r.pickupCode}</span>` : `<span class="muted">${r.status}</span>`}</td>
            <td>${r.status === "reserved" ? `<button class="secondary cancel" data-id="${r.id}">Cancel</button>` : ""}</td>
          </tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">Nothing reserved yet.</p>`;
}

$("listings").addEventListener("change", (e) => {
  if (!e.target.classList.contains("portions")) return;
  const card = e.target.closest(".listing");
  card.querySelector(".tip").value = "0.00";
});

$("listings").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("reserve")) return;
  const card = e.target.closest(".listing");
  const error = card.querySelector(".error");
  error.textContent = "";
  e.target.disabled = true;
  try {
    const r = await api("/api/reservations", {
      method: "POST",
      body: {
        userId: user.id,
        listingId: card.dataset.id,
        portions: Number(card.querySelector(".portions").value),
        tip: Number(card.querySelector(".tip").value),
      },
    });
    toast(`Reserved! Show code ${r.pickupCode} at ${r.listing.restaurantName}. Total ${euro(r.total)} including a ${euro(r.tip)} tip (payment is simulated in this prototype).`);
    refresh();
  } catch (err) {
    error.textContent = err.message;
    e.target.disabled = false;
  }
});

$("reservations").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("cancel")) return;
  await api(`/api/reservations/${e.target.dataset.id}/cancel`, { method: "POST", body: { userId: user.id } });
  refresh();
});

$("join").addEventListener("click", async () => {
  const name = $("name").value.trim();
  if (!name) return ($("signupError").textContent = "Please enter your name");
  $("join").disabled = true;
  const pos = await getPosition();
  try {
    user = await api("/api/users", { method: "POST", body: { name, ...pos, radiusKm: Number($("radius").value) } });
    localStorage.setItem("foodloopUser", user.id);
    showApp();
  } catch (err) {
    $("signupError").textContent = err.message;
    $("join").disabled = false;
  }
});

async function updateUser(body) {
  user = await api(`/api/users/${user.id}`, { method: "PATCH", body });
  showApp();
}
$("relocate").addEventListener("click", async () => updateUser(await getPosition()));
$("radius2").addEventListener("change", () => updateUser({ radiusKm: Number($("radius2").value) }));
$("enableAlerts").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("This browser doesn't support notifications");
  const result = await Notification.requestPermission();
  toast(result === "granted" ? "Browser alerts enabled" : "Alerts not enabled — you'll still see in-app notices");
});

(async function init() {
  cfg = await api("/api/config");
  connectLiveFeed();
  const saved = localStorage.getItem("foodloopUser");
  if (saved) {
    try {
      user = await api(`/api/users/${saved}`);
      return showApp();
    } catch {
      localStorage.removeItem("foodloopUser");
    }
  }
})();
