const $ = (id) => document.getElementById(id);
const euro = (n) => `€${Number(n).toFixed(2)}`;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

const minDonation = (portions) => Math.round((cfg.packagingPerPortion * portions + cfg.platformFee) * 100) / 100;

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
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(cfg.center),
      { timeout: 8000 },
    );
  });
}

function showApp() {
  $("signup").classList.add("hidden");
  ["settings", "feed", "mine"].forEach((id) => $(id).classList.remove("hidden"));
  $("whoami").textContent = `Hi ${user.name}`;
  $("radius2").value = String(user.radiusKm);
  $("locationLabel").textContent = `Location ${user.lat.toFixed(3)}, ${user.lng.toFixed(3)} · alerts within ${user.radiusKm} km`;
  $("limits").textContent =
    `Fair-share rules: max ${cfg.maxPortionsPerListingPerUser} portions per listing and ${cfg.maxReservationsPerDayPerUser} listings per day. ` +
    `Minimum donation: ${euro(cfg.packagingPerPortion)} packaging per portion + ${euro(cfg.platformFee)} for the app.`;
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
  const [listings, reservations] = await Promise.all([
    api(`/api/listings?lat=${user.lat}&lng=${user.lng}&radiusKm=${Math.max(user.radiusKm, 10)}`),
    api(`/api/users/${user.id}/reservations`),
  ]);
  renderListings(listings);
  renderReservations(reservations);
}

let seenListings = null;

function renderListings(listings) {
  // Keep what the user already chose/typed when the list refreshes live.
  const kept = {};
  for (const card of $("listings").querySelectorAll(".listing")) {
    kept[card.dataset.id] = {
      portions: card.querySelector(".portions")?.value,
      donation: card.querySelector(".donation")?.value,
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
          <label class="muted">Donation € <input class="donation" type="number" step="0.5" style="width:80px" value="${minDonation(1).toFixed(2)}" /></label>
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
      if (k.donation) card.querySelector(".donation").value = k.donation;
      card.querySelector(".error").textContent = k.error || "";
    }
    if (seenListings && !seenListings.has(card.dataset.id)) card.classList.add("flash");
    if (card.dataset.id === focused) card.querySelector(".donation").focus();
  }
  seenListings = new Set(listings.map((l) => l.id));
}

function renderReservations(list) {
  $("reservations").innerHTML = list.length
    ? `<table><tr><th>Food</th><th>Portions</th><th>Donation</th><th>Pickup code</th><th></th></tr>${list
        .map(
          (r) => `<tr>
            <td>${esc(r.listing?.title)}<div class="muted">${esc(r.listing?.restaurantName)} · ${r.listing ? `${time(r.listing.pickupStart)}–${time(r.listing.pickupEnd)}` : ""}</div></td>
            <td>${r.portions}</td><td>${euro(r.donation)}</td>
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
  card.querySelector(".donation").value = minDonation(Number(e.target.value)).toFixed(2);
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
        donation: Number(card.querySelector(".donation").value),
      },
    });
    toast(`Reserved! Show code ${r.pickupCode} at ${r.listing.restaurantName}. Donation ${euro(r.donation)} (payment is simulated in this prototype).`);
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
