# FoodLoop

Rescue surplus restaurant food in Amsterdam. Six agents work together:

| # | Agent | File | What it does |
|---|-------|------|--------------|
| 1 | **Restaurant Finder** | `src/agents/finder.ts` | Pulls restaurants, cafés and takeaways inside Amsterdam from **Google Places** when `GOOGLE_PLACES_API_KEY` is set, otherwise from OpenStreetMap (Overpass API, no key needed). See [Google Maps](#google-maps). |
| 2 | **Outreach** | `src/agents/outreach.ts` | Messages restaurants asking about today's surplus (Claude drafts the message), then reads their free-text replies (Dutch or English) and extracts a structured report: items, portions, dietary tags, pickup window. Asks a follow-up if the quantity is missing and respects STOP. |
| 3 | **Publisher & Notifier** | `src/agents/publisher.ts` | Writes the listing (Claude writes the copy), applies the fair-share limits, publishes it in the app and instantly alerts every user whose radius covers the restaurant. |
| 4 | **Router** | `src/agents/router.ts` | Decides the best action for every surplus item: **sell** in the app, **donate** to a food bank (big batches), **reuse** in tomorrow's menu (ingredients with too little time left), **compost**, or **biogas** (large inedible volumes). Rules act as a safety floor: anything that looks spoiled never goes to people, whatever Claude says. |
| 5 | **Chef** | `src/agents/chef.ts` | Turns leftovers into 1-2 recipes. Runs automatically for food routed to "reuse", and from the agent console. |
| 6 | **Forecast** | `src/agents/forecast.ts` | Predicts today's surplus per restaurant from its history (same weekday first). **Contact likely surplus** in the console messages those restaurants first. |

`src/impact.ts` closes the loop: it tracks kg rescued, CO₂e avoided, compost and biogas made, and compost delivered to partner farms (food banks, composters, biogas plants, farms). The estimates are configurable in `.env`. Listings from restaurants that compost with a partner get a **Closes the loop** badge. Add fictional demo partners from the console, or let the simulator add them.

```
Google Places / OSM ──► Finder ──► restaurants ──► Outreach ──► restaurant reply
                                                              │  (Claude extracts surplus)
users nearby ◄── live alert ◄── Publisher ◄── surplus report ◄┘
     │
     └─► reserve (portion limits) + donation for packaging & app ──► pickup code
```

## Rules in the app

- **Base price plus optional tip.** The default base price is €2.50 per portion. Users can add any tip, including €0.
- **Purchase limits.** Max 2 portions per listing per person (fewer on small batches), and max 2 listings per person per day.
- **Pickup window.** Listings expire automatically after the window ends.

You can change all of these in `.env` (see `.env.example`).

## Run it

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY to switch on the AI agents
npm start
```

- Landing page: http://localhost:3000
- User app: http://localhost:3000/app.html
- Agent console: http://localhost:3000/admin.html

Without an API key, FoodLoop runs in **offline mode**. Outreach and reply parsing then use simple rules (for example, "8 portions of lasagne, pickup 21:00-22:00"), so you can try the whole flow for free.

### Google Maps

Both keys are optional and can be the same key while testing locally.

| Variable | Google API to enable | Used for |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | Places API (New) | The finder searches Amsterdam with Nearby Search on a ~1 km grid. Cells with a full page of results are split into 4 and searched again. It keeps only operational places with an Amsterdam address and de-duplicates by `place_id`. It also merges places already found via OpenStreetMap (same name, within 100 m) so nobody is contacted twice. It stores phone, website, cuisine and opening hours. |
| `GOOGLE_MAPS_API_KEY` | Maps JavaScript API | Shows a map in the user app: you, your alert radius, food available (green pins) and restaurants (grey dots). Click a pin for details, directions or to jump to the listing. This key is sent to browsers, so restrict it by HTTP referrer. |

- **Cost:** Places Nearby Search is billed per request. A limited run (`npm run find -- 50`, or **Limit** in the console) searches the centre first and stops at the limit. A full-city run takes a few hundred requests. The console and CLI report how many requests were made. The live simulator always uses free OSM data.
- **Pick a source:** use the **Source** menu in the console, or run `npm run find -- 200 osm` / `npm run find -- 200 google`.
- **Without keys:** every listing and restaurant card still has **Open in Google Maps** and **Directions** links. These need no key.
- **Google's terms:** only the official API is used. `place_id` is kept permanently, and the other fields are refreshed on each finder run.

### Demo flow
1. In the agent console, click **Find restaurants** (Google Places or real OSM data) or **Add 5 demo restaurants**.
2. In another tab, open the user app (`/app.html`) and join. Allow location, or it falls back to central Amsterdam.
3. Back in the console, click **Run outreach**, pick a restaurant and send a reply as the restaurant, e.g.
   *"Ja! We have 8 portions of vegetarian lasagne and 5 croissants, pickup 21:00-22:00"*.
4. The user app shows a live alert and the listing. Reserve a portion to get a pickup code.

CLI equivalents: `npm run find -- 200`, `npm run seed`, `npm run outreach -- 10`.

## Live simulation (test with real data)

```bash
npm run live
```

- On first run it loads **800 real Amsterdam restaurants** from OpenStreetMap.
- Every 20 seconds, a random restaurant "replies" with realistic surplus in English or Dutch (e.g. *"Hoi! We hebben 6 porties stamppot, ophalen 20:30 tot 21:45"*). The reply goes through the **real** agents: outreach reads it, follow-ups are asked when it's vague, and the publisher posts it and alerts nearby users.
- 40 simulated neighbours reserve portions under the same limits as real users, so you see portions tick down live in the app and on the landing page.
- Every simulated listing shows a **Test data** badge: the restaurant is real, the surplus is made up.
- Pause, change speed, watch the activity feed, or clear all simulated data in the agent console (`/admin.html`).
- With `ANTHROPIC_API_KEY` set, the simulator uses Claude too, at about 3 API calls per simulated restaurant.

**On your phone:** connect to the same Wi-Fi and open the "On your phone" address the server prints at startup. Browsers only allow location access on `https` or `localhost`, so over Wi-Fi the app falls back to central Amsterdam. On the first run, Windows may ask to allow Node.js through the firewall.

## Going to production: next steps

- **Real outreach channel:** implement `OutreachChannel` (`src/channels/channel.ts`) for WhatsApp Business (only message restaurants that opted in) or email. Replies come in via a webhook that calls `handleReply()`.
- **Payments:** donations are only recorded right now. Integrate Mollie (Dutch, supports iDEAL) or Stripe before accepting real money.
- **Accounts & push:** add real auth, and web push / mobile push so alerts arrive when the app is closed. Today they use Server-Sent Events plus browser notifications while the app is open.
- **Database:** swap the JSON file (`src/store.ts`) for Postgres/SQLite.
- **Food safety:** add restaurant verification and allergen info before going live (NVWA rules for food donation).
