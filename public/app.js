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

// Google Maps links work without an API key.
function mapsSearchUrl({ name, address, lat, lng, placeId }) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", name ? [name, address].filter(Boolean).join(", ") : `${lat},${lng}`);
  if (placeId) url.searchParams.set("query_place_id", placeId);
  return url.href;
}
function directionsUrl({ lat, lng, placeId }) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${lat},${lng}`);
  if (placeId) url.searchParams.set("destination_place_id", placeId);
  url.searchParams.set("travelmode", "walking");
  return url.href;
}
const mapsLinks = (place) => `<div class="maps-links">
  <a href="${esc(mapsSearchUrl(place))}" target="_blank" rel="noreferrer">Open in Google Maps</a>
  <a href="${esc(directionsUrl(place))}" target="_blank" rel="noreferrer">Directions</a>
</div>`;

// Google weekday descriptions start on Monday.
const todaysHours = (hours) => hours?.[(new Date().getDay() + 6) % 7];

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
  $("mapSection").classList.toggle("hidden", !cfg.googleMapsApiKey);
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
  renderMap(listings, restaurants);
}

// ---------- Google Map (only when GOOGLE_MAPS_API_KEY is set) ----------
let map;
let infoWindow;
let radiusCircle;
let mapMarkers = [];
let mapViewKey;

function loadGoogleMaps() {
  loadGoogleMaps.promise ??= new Promise((resolve, reject) => {
    window.foodloopMapsReady = resolve;
    // Called by Google when the key is invalid, restricted or the API isn't enabled.
    window.gm_authFailure = () => showMapError("Google Maps rejected the API key. Check that the Maps JavaScript API is enabled and the key allows this site.");
    const script = document.createElement("script");
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsApiKey)}` +
      "&v=weekly&loading=async&callback=foodloopMapsReady";
    script.async = true;
    script.onerror = () => reject(new Error("Google Maps failed to load. Check your connection."));
    document.head.append(script);
  });
  return loadGoogleMaps.promise;
}

function showMapError(text) {
  $("mapError").textContent = text;
}

function dot(kind) {
  const el = document.createElement("div");
  el.className = `map-dot ${kind}`;
  return el;
}

async function renderMap(listings, restaurants) {
  if (!cfg.googleMapsApiKey) return;
  try {
    await loadGoogleMaps();
    const { Map, InfoWindow, Circle } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
    const here = { lat: user.lat, lng: user.lng };

    if (!map) {
      map = new Map($("map"), {
        center: here,
        zoom: 14,
        mapId: cfg.googleMapsMapId,
        colorScheme: "DARK",
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: true,
      });
      infoWindow = new InfoWindow();
      radiusCircle = new Circle({
        map,
        strokeColor: "#4c8dff",
        strokeOpacity: 0.7,
        strokeWeight: 1,
        fillColor: "#4c8dff",
        fillOpacity: 0.08,
        clickable: false,
      });
      // "Go to listing" links inside info windows.
      $("map").addEventListener("click", (e) => {
        const id = e.target.closest?.("[data-goto]")?.dataset.goto;
        const card = id && $("listings").querySelector(`.listing[data-id="${CSS.escape(id)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.remove("flash");
        void card.offsetWidth;
        card.classList.add("flash");
      });
    }

    // Re-centre only when the user's location or radius changes, not on every live refresh.
    radiusCircle.setCenter(here);
    radiusCircle.setRadius(user.radiusKm * 1000);
    const viewKey = `${user.lat},${user.lng},${user.radiusKm}`;
    if (viewKey !== mapViewKey) {
      mapViewKey = viewKey;
      map.fitBounds(radiusCircle.getBounds());
    }

    for (const marker of mapMarkers) marker.map = null;
    mapMarkers = [];
    const add = (options, html) => {
      const marker = new AdvancedMarkerElement({ map, gmpClickable: Boolean(html), ...options });
      if (html) {
        marker.addEventListener("gmp-click", () => {
          infoWindow.setContent(html);
          infoWindow.open({ map, anchor: marker });
        });
      }
      mapMarkers.push(marker);
    };

    add({ position: here, content: dot("you"), title: "You", zIndex: 1000 });

    for (const r of restaurants) {
      const hours = todaysHours(r.openingHours);
      add(
        { position: { lat: r.lat, lng: r.lng }, content: dot("place"), title: r.name },
        `<div class="map-info">
          <h3>${esc(r.name)}</h3>
          <div class="info-muted">${esc(r.cuisine || "Restaurant")} · ${r.distanceKm} km</div>
          <div>${esc(r.address || "")}</div>
          ${hours ? `<div class="info-muted">${esc(hours)}</div>` : ""}
          ${mapsLinks(r)}
        </div>`,
      );
    }

    for (const l of listings) {
      const pin = new PinElement({ background: "#7fd89b", borderColor: "#2f6b44", glyphColor: "#0c1a10", scale: 1.15 });
      add(
        { position: { lat: l.lat, lng: l.lng }, content: pin.element, title: `${l.title} · ${l.restaurantName}`, zIndex: 500 },
        `<div class="map-info">
          <h3>${esc(l.title)}</h3>
          <div class="info-muted">${esc(l.restaurantName)} · ${l.distanceKm} km</div>
          <div>${l.remainingPortions} of ${l.totalPortions} portions left</div>
          <div>Pickup ${time(l.pickupStart)}–${time(l.pickupEnd)}</div>
          <div class="maps-links">
            <button class="link" data-goto="${esc(l.id)}">Reserve</button>
            <a href="${esc(directionsUrl(l))}" target="_blank" rel="noreferrer">Directions</a>
          </div>
        </div>`,
      );
    }
    showMapError("");
  } catch (err) {
    showMapError(err.message);
  }
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
        ${mapsLinks({ name: l.restaurantName, address: l.address, lat: l.lat, lng: l.lng })}
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
      const hours = todaysHours(restaurant.openingHours);
      return `<article class="card">
        <h3>${esc(restaurant.name)}</h3>
        <div class="muted">${restaurant.distanceKm} km · ${esc(restaurant.cuisine || "Restaurant")}</div>
        <p class="meta">${esc(restaurant.address || "Address unavailable")}</p>
        ${hours ? `<div class="muted">${esc(hours)}</div>` : ""}
        ${restaurant.phone ? `<div><a href="tel:${encodeURIComponent(restaurant.phone)}">${esc(restaurant.phone)}</a></div>` : ""}
        ${restaurant.email ? `<div><a href="mailto:${encodeURIComponent(restaurant.email)}">${esc(restaurant.email)}</a></div>` : ""}
        ${website ? `<div><a href="${esc(website)}" target="_blank" rel="noreferrer">Website</a></div>` : ""}
        ${mapsLinks(restaurant)}
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
