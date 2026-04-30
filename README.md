# OPERATION: HYDRO STRIKE — RSVP Command

Mobile-first RSVP app for Elikai's 12th Birthday Water Balloon Battle. Deploys to Railway from GitHub. Postgres for storage. Rich link previews when texted.

## Stack
- Node 18+ / Express
- PostgreSQL (auto-init on boot — no migrations to run)
- Single repo, single Railway service

## What parents see
**When you text the URL**, iMessage / WhatsApp / Slack / Discord all unfurl a 1200×630 share card with the invitation, the title "OPERATION HYDRO STRIKE", date/time/location, and "TAP TO RSVP →". That's what pulls them in.

**When they tap the link**, mobile-optimized briefing with:
- The invitation image
- Mission objective (game explanation, BLUE vs RED squads)
- Required loadout (what to bring — clothes that can get soaked, towel, water shoes, etc.)
- Time + coordinates + tap-to-open-in-Maps button
- Pizza party note
- ENLIST form: parent info, kid name(s), kid count, attending status, squad preference, allergies, notes

## Deploy on Railway

1. **Push this repo to GitHub** (e.g. `landonyourfeet/hydro-strike-rsvp`).
2. **Railway → New Project → Deploy from GitHub Repo**, pick the repo.
3. **Add a Postgres plugin** to the project (`+ New → Database → PostgreSQL`).
4. Open the **service settings → Variables** and set:
   - `ADMIN_KEY` — strong password, gates `/admin`
   - `PUBLIC_URL` — the Railway public domain, e.g. `https://hydro-strike.up.railway.app`
     (this is used as the absolute URL for og:image, so link previews always work)
   - `DATABASE_URL` — auto-injected by the Postgres plugin, leave it
5. Generate a public domain (`Settings → Networking → Generate Domain`).
6. Done. Railway runs `npm start` automatically.

## Routes
| Path | What |
|---|---|
| `GET /` | Public RSVP page (mobile-optimized, military briefing) |
| `GET /admin` | Roster + stats (gated by `ADMIN_KEY`) |
| `POST /api/rsvp` | Submit RSVP |
| `GET /api/rsvps?key=...` | JSON roster + stats |
| `DELETE /api/rsvp/:id?key=...` | Remove an RSVP |
| `GET /health` | Liveness check |
| `GET /share-card.jpg` | OG link preview image (1200×630) |
| `GET /invitation.jpg` | Original invitation |

## Sharing the link
Text the Railway URL directly. Example:

> Hey! Sending Mason an invite to my son Elikai's 12th birthday water balloon battle this Saturday — full briefing + RSVP here: https://hydro-strike.up.railway.app

iMessage shows the rich card. Parents tap. Done.

## Admin access
Visit `https://yourdomain/admin` — enter `ADMIN_KEY`. It's stored in `sessionStorage` so you only enter once per browser session.

The admin page shows live stats (CONFIRMED / MAYBE / TOTAL KIDS / BLUE SQUAD / RED SQUAD), a searchable roster table with all submissions, and a CSV export button. Auto-refreshes every 30s.

## Customizing
- **Change the share-card text/colors:** regenerate `public/share-card.jpg` with your own image
- **Add fields:** add to the form in `public/index.html` AND the INSERT in `server.js` (and the table in `initDB`)
- **Different event:** swap `invitation.jpg` and `share-card.jpg`, edit the OBJECTIVE/LOADOUT/INTEL text in `index.html`
