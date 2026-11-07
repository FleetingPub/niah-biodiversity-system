# Niah Plant Records (website)

The website for the Digital Plant Knowledge System. It has two sides: public pages where anyone can
look up the plants of Niah National Park, and a dashboard where SFC staff review records, manage
species and keep an eye on the sensors. It's built with Next.js 16 (App Router) and Tailwind CSS 4.

The original item 13 wireframe is still the visual baseline. Staff sign in, the species pages on
the dashboard (add, edit and delete) and the public pages (home, plant list, plant pages and tag
pages) now use Supabase (items 14 to 16), and so do the dashboard records pages (item 17), the
photos (item 18), the maps (item 20), reports (item 21), the review queue (item 19) and the
overview's records and counts. The users page is real too (item 2), and so are the sensor pages
(items 28 to 31). [`iot/Field_Node_Edge-to-Cloud_Setup_Guide.md`](../iot/Field_Node_Edge-to-Cloud_Setup_Guide.md)
covers the nodes, the edge devices and `edge-com`.

| Side | Screens |
| --- | --- |
| Public | Home, plant list with search, a page for each plant, scan a tag, tag pages, staff sign in |
| Staff | Overview, species, add, edit and delete a species, records, edit and delete a record, review queue, reports, sensors, users and roles |

## Running it

```bash
cd web
npm install
npm run dev
```

Then open http://localhost:3000. The public pages and staff sign in use Supabase when configured,
so copy `.env.example` to `.env.local` and fill in the project URL and publishable key. The app
accepts both `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` and the Supabase export
names `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY`. Without them `/login` says sign in isn't set up
and `/dashboard` sends you back to `/login`. A production build (`npm run build`) also needs the
project URL to start with `https://` (item 23), and treats any other URL as not set up.

Set `SITE_URL` to the site's own address as well, and set it before the build, because some pages
with a tag on them get built ahead of time. It goes in the QR code on the tags drawn on the website
(item 12), so a phone camera can open the plant's page. It has to be `https://`, except for
`http://localhost` and `http://127.0.0.1` when trying it out. Without it the QR codes only hold the
tag code, which the phone app's Scan tab can still read. The phone app has its own
`EXPO_PUBLIC_SITE_URL`, and both should hold the same address.

With Supabase set up, the public pages read it on every visit, so new species and newly approved
records show up without a new build. They read the `species_public` and `records_public` views, so
the project needs 001 to 007 from `supabase/`. The photos need 009, and without it the pages
still work but show no photos. Set the values before `npm run build`, because a
page that was built without them keeps the sample data. If Supabase doesn't answer, the public
pages say "This page didn't load" instead of falling back to the sample data, so a problem can't
hide behind made up plants. Without the values they show the sample data in `src/data`.

For the demo, start at http://localhost:3000/screens. It lists every screen with what each one
does. Nothing on the site links to it, so type the address.

## Trying sign in without a Supabase project

`supabase/tests/stand-in.js` is a stand-in for our Supabase project that runs on your computer,
with a made up account for each role. It's for trying sign in and the dashboard without a real
project or real accounts. Start it in one terminal:

```bash
cd supabase/tests
npm install
npm run stand-in
```

Then start the website in a second terminal. On macOS or Linux:

```bash
cd web
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=stand-in-anon-key \
  SUPABASE_SERVICE_ROLE_KEY=stand-in-service-key npm run dev
```

In PowerShell on Windows:

```powershell
cd web
$env:NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "stand-in-anon-key"
$env:SUPABASE_SERVICE_ROLE_KEY = "stand-in-service-key"
npm run dev
```

Values set in the terminal win over `.env.local`, so there's no need to change it. In PowerShell
they stay set until you close that window. Sign in at http://localhost:3000/login as
`officer@example.test` or `admin@example.test`. The botanist, researcher, visitor and noprofile
accounts get "No access". The stand-in lists the accounts when it starts, and the password is
`TEST_PASSWORD` in `stand-in.js`. Everything in it is made up, and it all goes when you stop it.
[supabase/README.md](../supabase/README.md#tests) has more about it.

The stand-in also runs our `edge-com` function and starts with a day of made up readings from three
sensor nodes, so the Sensors page, its map and the overview have something to show: an urgent
alert, a routine one, one that ended by itself and a node that's gone quiet. Start it with
`STAND_IN_SENSOR_DATA=0` for no readings. Running `edge-com` needs Node 22.13 or newer. On an older
Node 22 the stand-in starts without it and says so.

This only works with `npm run dev`. The stand-in's URL is http, so a production build of the
website says sign in isn't set up.

Supabase sends at most 1000 rows for one request, so the pages that need every row (the counts,
the records list, the report and the CSV) read them through `readAll()` in
`src/lib/supabase/read-all.ts`, a page at a time. Start the stand-in with `STAND_IN_MAX_ROWS=3`
to try that with the sample records.

## What's where

```
src/
  app/
    layout.tsx          fonts and the skip link
    globals.css         colours, fonts and the shared classes (card, btn, field...)
    not-found.tsx       the 404 page
    (public)/           the public site. The brackets keep the folder name out of the URL
      error.tsx         what a public page shows when its data doesn't load
      plants/           plant list with search, and [slug] for one plant
      tag/              type in a tag code, and [code] for the page a QR tag opens
      login/            staff sign in and sign out, with Supabase Auth
      screens/          every screen, only reached by typing the address
    dashboard/          the staff side, with the sidebar in layout.tsx
      records/          the records table, and [id]/edit and [id]/delete
      review/           the review queue: approve or reject records from the mobile app, and send one back
      species/          the species table, new/ to add one, and [slug]/edit and [slug]/delete
      reports/          counts, charts and the print view, and csv/ for the download
      sensors/          alerts, the map, the sensor nodes and their history, commands, and devices/ for tokens and positions (admins)
      users/            who has an account and what each role can do
  components/           shared pieces: park map, tree tag, photo gallery, icons...
  data/                 mock species and records, plus the screen list
  lib/                  Supabase and sign in, species and record form checks, photos, IUCN labels, the location grid, report counts and the CSV
```

## Planned features

Still to build on the website. The item numbers match the proposal and `docs/sprint-1.md`.

| Item | What goes in | Where |
| --- | --- | --- |
| 32 | Sensors on the park and overview maps. `ParkMap` already takes them, with `mapStateOf()` from `src/lib/iot.ts` for each one's look, and the Sensors page has its own map. Alerts only show on the dashboard for now, and nothing is sent to a patrol team. | Overview, park map |

## Notes for the team

- All the data is made up. The coordinates sit around the park HQ, the names are fake and the
  emails use example.com. Never put the real location of a threatened or protected plant in mock
  data, screenshots or anything public.
- Public pages query the `species_public` and `records_public` views, never the tables.
  `records_public` only gives the exact spot of a plant whose species is LC or NT, isn't protected
  in Sarawak and isn't marked rough area only, and whose name matches the species it's linked to.
  Every other plant, including one the field team hasn't matched to a species yet, only gets the
  middle of its grid square and the day it was recorded, not the time (007, 019). Keep the exact
  spots of threatened and protected plants in server-only staff workflows, and never select them
  into a public page response.
- The pages use the same rule, `showsExactSpot()` in `src/lib/iucn.ts` (through `hidesLocation()`
  and `recordHidesLocation()` in `src/data/species.ts`, which also checks the name), so a plant the
  view hides is never drawn as an exact dot. For those plants the server snaps the point to a
  0.004 degree grid square (about 440 m at Niah) in `src/lib/geo.ts` before it sends the page, so
  the exact point never reaches the browser, even with the sample data. Keep it that way on every
  public page.
- Client components (files starting with `"use client"`) only import from `src/lib` and
  `src/components`, never from `src/data`, because anything they import gets sent to the browser.
  `import type` from `src/data` is fine since types disappear at build time. The map is a client
  component for the same reason: everything a page gives `ParkMap` ends up in the browser, so pages
  work out the points on the server and pass rough squares from `src/lib/geo.ts`, never the points,
  for a plant whose spot is hidden.
- The maps, the Sensors page's included, use Leaflet with OpenStreetMap's own tiles, which come
  straight from openstreetmap.org into the visitor's browser. That's fine under OSM's tile policy
  for a student project with little traffic, as long as the attribution in the corner stays. If
  the site ever gets real traffic it should move to a tile provider that allows it.
- Park HQ is `PARK_HQ` in `src/lib/geo.ts`. The maps mark it and always keep it in view, and a
  tree tag page whose plant has a public spot says how far it is from HQ ("about 130 m north of
  park HQ"). It's the same point the mobile app's mock records sit around and the simulator step
  in `mobile/README.md` uses, but nobody has checked it against the real HQ buildings, and on the
  OSM tiles it lands in the forest. Someone who knows the park (SFC, or a team member who has
  been) should find the HQ on the map before launch. Changing the point moves the HQ marker and
  the distances on the tag pages, but no plant moves, since every record has its own point. If it
  changes, change the comment in `mobile/src/data/mock-records.ts` and the simulator step in
  `mobile/README.md` too.
- Every staff page starts with `if (!(await requireStaff())) return null;` from
  `src/lib/auth.ts`, and a new staff page needs it too. The check in `dashboard/layout.tsx` isn't
  enough on its own. Next renders a page and its layout at the same time, so a layout that shows
  "No access" doesn't stop the page's data from reaching the browser.
- The review queue (`dashboard/review`) saves a decision with the `reviewRecord` server action. A decision only goes through if the record is still in the status the page showed and nobody has saved it since (the same `updated_at` check as the edit forms), so two officers can't decide on the same record. Rejecting needs a reason, which goes in `review_notes` for the phone to show once item 10 downloads it. Approving clears an old reason, and sending a record back to the queue keeps it. The checks are in `src/lib/review.ts`, and the database has the last word on who can review (006).
- Staff pages do send exact points to the browser (the review queue and the overview map). The
  reports page doesn't. Its CSV is built in `dashboard/reports/csv/route.ts`, which checks the role
  again before it sends anything. The database checks roles too (006, item 4), so the staff views
  give anyone else nothing.
- Sign in and the species forms post to server actions, so nothing anyone types ends up in the
  address bar. The other wireframe forms don't have `name` attributes and never submit anywhere.
  The plant search keeps `?q=` in the URL on purpose, so a search can be shared.
- Sign in has a limit of its own in `src/lib/rate-limit.ts`, as well as the one Supabase Auth has.
  After 5 wrong tries for one email, or 20 from one address, in 15 minutes, `/login` says "Too
  many tries" and doesn't send the sign in to Supabase until the oldest of those tries is 15
  minutes old. Signing in starts that email's count again. The counts are kept in the server's
  memory, so each copy of the server has its own and a restart clears them. Wrong tries count
  against an email whoever makes them, which is why the wait is minutes and not hours. The
  address is the first one in `x-forwarded-for`, or `x-real-ip`, as the host in front of the
  server passes it on.
- The species form checks live in `src/lib/species-form.ts`, so the page runs them before it sends
  the form and the server action runs them again before it saves. A species' scientific name can't
  change once it's added, because its public page link and its records use it.
- The record form checks live in `src/lib/record-form.ts` the same way, and follow the mobile app's
  rules for height and notes. Editing a record never changes its status, tag or who uploaded it, and
  a published record stays published. Deleting one can't be undone on the website and its tag stops
  working. A phone that hasn't synced the record yet can't bring it back, because the database turns
  that upload down (010, `docs/sync-design.md`).
- Species photos are uploaded on the species edit page (item 18) into the public `botanical-photos`
  bucket. The server action turns each one into a JPEG up to 1600 pixels across with `sharp` and
  leaves out the EXIF data, because a phone can save where a photo was taken in the file. It also
  saves a small copy next to it (`-small.jpg`) for the plant list and the gallery's squares, and
  marks the photo with `small`. Never upload a species photo any other way, and never put a photo
  that shows where a threatened plant grows in that bucket. Files are limited to 4 MB, which fits
  under the 4.5 MB a Vercel request can be (`bodySizeLimit` in `next.config.ts`).
- Field photos from the phone go in the private `record-photos` bucket. Only staff pages show
  them, through signed links that last an hour (`src/lib/record-photos.ts`). Never show them on a
  public page.
- Photos are plain `<img>` tags, not `next/image`, because the image optimizer won't fetch from
  a local address like the stand-in's.
- Login cookies are set in `src/lib/supabase/config.ts`. Page scripts can't read them, a production
  build only sends them over https, and they last 12 hours from the last session refresh. Safari
  won't keep them on `http://localhost` after `npm start`, so try a production build in Chrome.
- Dates are formatted by hand in `src/lib/format.ts`, so the server and the browser print the same
  thing. Don't call `new Date()` or `Date.now()` while a page renders. In a client component it
  causes hydration errors, and in a server component that doesn't read the cookies the date gets
  frozen at build time. For today's date use `parkNow()`, and only in a route handler or a server
  component that already reads the cookies, like the overview. Supabase sends times in UTC, so
  pass them through `parkTime()` first. Niah is 8 hours ahead, so a plant recorded at 4:30 pm UTC
  on 27 Sep was recorded on 28 Sep at the park.
- The six mock records have the same IDs and tag codes as `mobile/src/data/mock-records.ts` (for
  example the Belian is NNP-3F2A9C in both). If you change one file, change the other. The seed
  records in `supabase/002_seed_data.sql` only partly match: NNP-5E9A2C is approved there but
  waiting in the mock data, and the seed has NNP-9F8E7D and NNP-2A1B0C instead of NNP-72C5F8 and
  NNP-D4B86E. So `/tag` uses NNP-D4B86E as its example of a tag with no public page. It has none
  with Supabase or with the sample data.
- Write Tailwind class names out in full. Tailwind can't find a class that's glued together from
  bits of strings, so it never ends up in the CSS.
- A box that scrolls sideways (`overflow-x-auto`) also needs `relative`. Otherwise screen reader
  only text inside it can poke out past the edge and make the whole page scroll on phones.

## Before you open a pull request

```bash
npm run lint
npm test
npm run build
```

All three should pass with no errors. The build prints two warnings about font fallbacks for
Atkinson Hyperlegible ("Failed to find font override values"). They're harmless. They only mean
Next can't make a size matched backup font while the real one loads.

`npm test` runs the unit tests (`src/**/*.test.mjs`) with Node's own test runner, which can load
the TypeScript files they test. So far only the sign in limit has them
(`src/lib/rate-limit.test.mjs`). For the rest, click through the pages you changed, including at
375 px wide in the browser's dev tools, and check nothing scrolls sideways. GitHub runs lint, the
unit tests and the build again on every pull request and every push to `main`.

Manual test results go in `docs/test-results/`. See the item 13 one for the website.
