# Supabase

The database tables, Row Level Security policies, Storage buckets and seed data, as numbered
`.sql` files, so the whole team can see and review every change to the database.

## Running the SQL files

Run them in the Supabase SQL editor (SQL Editor, New query, paste the whole file, Run), in this
order. The SQL editor runs a whole file as one transaction, so if a file fails, nothing from it is
kept, and you can fix the problem and run it again.

| File | What it does | Item | Safe to run again? |
| --- | --- | --- | --- |
| `001_initial_schema.sql` | The tables (profiles, species, records, iot_nodes), Row Level Security, and the public `botanical-photos` bucket | 14 | No, it stops on the policies that are already there |
| `002_seed_data.sql` | The species, the sample records and three sample sensor nodes, with their names and zones and no readings yet | 14 | Only on a new project. It writes the sample species' facts and photos back over any changes made on the website. If it does run again, run 007 again after it |
| `003_profiles_read_own.sql` | Lets a signed in user read their own profile, so the website can see their role, and takes out an old view from 001 that nothing uses | 15 | Yes |
| `004_security_hardening.sql` | Role checks on writes, the public views and the staff views | 4, 14, 15, 16 | No, it stops on the policies that are already there |
| `005_phone_sync.sql` | Lets the phone upload records, and adds the private `record-photos` bucket | 3 | No, it stops on its first line and changes nothing |
| `006_role_based_access.sql` | What each role can read and change, checked by the database: Row Level Security, column grants and a review trigger | 4 | Yes, then run 007, 008, 016_2 and 019 again. The public still can't see the exact spot of a plant set to rough area only in between |
| `007_species_fixes.sql` | The rough area only switch for a species, the public views that use it, checked facts for the sample species, and a trigger that sets `updated_at` when a species is edited | 14 | Yes, then run 019 again, because this puts the older public view back |
| `008_record_edits.sql` | `updated_at` on records, set by a trigger when a record is edited, and the staff view that shows it | 17 | Yes |
| `009_species_photos.sql` | Checks what goes in `species.photos`, the `species_photos_public` view for the plant pages, and lets officers and admins delete record photos | 18 | Yes |
| `010_deleted_records.sql` | Keeps the ID of every deleted record, with who deleted it and when, so a phone can't upload it again | 3, 17 | Yes |
| `011_exact_location_downloads.sql` | Keeps a list of every report downloaded with the exact spots of threatened and protected plants, with who downloaded it and when. Only admins can read the list, and nobody can change it | 21 | Yes |
| `012_report_counts.sql` | Counts the records for the Reports page in the database, as whoever is asking, so the page doesn't load every record to count them | 21 | Yes, then run 019 again, because this puts the older counts back |
| `013_edit_history.sql` | Keeps a history of every change to a record or species, with who saved it and when, for the edit pages. Only officers and admins can read it, and nobody can change it. It never keeps a plant's map location, but text like notes is kept word for word | 17, 18 | Yes |
| `014_photo_folder.sql` | Keeps the name of each record's photo folder, so the website can still show and delete a record's photos after the account that sent it is deleted | 18 | Yes |
| `015_species_rough_area.sql` | Keeps rough area only on for every threatened or protected species, so the first save on the edit page doesn't write a false history line. The public sees the same as before | 17 | Yes |
| `016_1_iot_devices.sql` | The edge devices, one for each forest region, with their position. Admins manage them, officers can see them | 28 | Yes |
| `016_2_iot_nodes.sql` | Links each node in `iot_nodes` to its edge device, and gives each node its own calibration and alert settings | 28, 29 | Yes |
| `016_3_iot_device_tokens.sql` | A hash of each edge device's token, and `iot_make_device_token` for the Devices page | 28 | Yes. The tokens are kept |
| `016_4_iot_readings.sql` | The readings, with raw values only, and `iot_raw_pct`, which turns a raw value into a percentage with a node's calibration | 28, 29 | Yes. The readings are kept |
| `017_iot_alerts.sql` | The alerts, the check for nodes going quiet, acknowledging and resolving, each node's status, and the `iot_node_status` view for the Sensors page | 31 | Yes |
| `019_public_record_details.sql` | Gives the public less about a plant whose spot is hidden: the day a record was made, not the time, and the spot stays hidden when a record's name disagrees with its species. The Reports counts follow the same rule | 26 | Yes |
| `020_record_photo_access.sql` | Someone who loses their field staff role also loses their own record photos, and people who aren't signed in can't call the helper functions | 26 | Yes |
| `021_role_changes.sql` | Keeps a list of every role change, with who made it and when, for the Users page, and makes sure administrators can't remove each other at the same moment and leave nobody. Only admins can read the list, and nobody can change it | 26 | Yes. The list is kept |
| `022_iot_reading_limit.sql` | Limits each edge device to 3,600 readings an hour. An upload that would go over is refused with HTTP 429 and none of it is kept, so the device sends it again later | 26 | Yes. To change the limit, change the number in it and run it again |
| `023_iot_boots.sql` | Each node's power-ups: where it's installed and the first and last reading that arrived | 28 | Yes |
| `024_iot_alert_state.sql` | The edge-com function's working state for deciding alerts. Nobody reads it through the API | 31 | Yes |
| `025_iot_commands.sql` | Commands for the nodes (the locate beep and a baseline reset), which officers and admins send from the Sensors page | 31 | Yes |

On a new project, run 001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015,
016_1 to 017, 019, 020, 021 and 022 to 025, one file at a time, in that order, and don't stop part
way. There's no 018 file: the number was held for the phone's photos, and they
didn't need one. The website's species pages (add, edit and delete) and its public pages need 007,
and 007 stops on its first line if 006 isn't there. Until then the public pages say "This page
didn't load". Without 009 the plant pages show no photos. Without 010 a phone that hadn't synced a
record can upload it again after an officer deletes it. Without 011 the website turns down every
report download with exact spots, because it can't put the download on the list. Without 012 the
Reports page says the records didn't load, but the spreadsheet download still works. 012 stops on
its first line if 011 isn't there. Without 013 the edit pages say the history didn't load, and
saving still works. 013 stops on its first line if 012 isn't there. Without 014 the website finds a
record's photos from `submitted_by`, so they're lost when the account that sent it is deleted. 014
stops on its first line if 013 isn't there. Without 015 the first save of a threatened or protected
species can say its place on the public map changed when it didn't. 015 stops on its first line if
014 isn't there. Without the sensor steps (below) the Sensors page and the overview say the database
hasn't been set up for sensors, and the staff menu has no badge, but the other pages aren't
affected. With 016_1 to 016_4 but not 017, the Devices page works and the Sensors page says the
same. Without 019 the public views and the Reports
counts stay as 007 and 012 left them. 019 stops on its first line if 017 isn't there. Without 020
record photos and the helper functions keep the access the earlier files gave them. 020 stops on its
first line if 019 isn't there. Without 021 role changes aren't written down and the Users page says
so. Changing roles still works. 021 stops on its first line if 020 isn't there. The list only starts
once 021 is in, so earlier changes aren't in it. Without 022 nothing limits how many readings an
edge device can add. 022 stops on its first line if 021 isn't there. 003 is fine to run even if it
turns out to be there already. The history only starts once 013 is in, so changes made before
that aren't in it.

The sensor steps are 016_1, 016_2, 016_3, 016_4 and 017 after 015, then 022, 023, 024 and 025
after 021. Each stops on its first line if the one before it isn't there (022 checks for 021). Then
deploy the `edge-com` Edge Function (`functions/edge-com/index.ts`) with JWT verification turned
off. Then an admin opens **Sensors**, then **Devices**, adds each edge device with its position,
links its nodes and makes it a token.
[`iot/Field_Node_Edge-to-Cloud_Setup_Guide.md`](../iot/Field_Node_Edge-to-Cloud_Setup_Guide.md) has
the rest. Each node's calibration and alert limits are in its row of `iot_nodes`; they're starting
values to tune, and nobody has tried them in the field.

Before running 004, open the `profiles` table in the Table Editor and check every role there is
one an admin gave on purpose. Set any you don't recognise back to `visitor`. If nobody needs to
sign up on the website or the app yet, turn sign ups off in the Supabase dashboard
(Authentication, Sign In / Providers) until 003 to 021 are in. Staff accounts can still be added
by hand there.

If 005 stops with a check error (like `records_gps_check`), a record already on the hosted project
breaks one of its new rules. Fix or delete that record in the Table Editor and run 005 again.

## Sample data

The sample records use made-up points around park HQ, not real plant locations, like the mock
records in both apps. The comment in 002 says they match the mock records, but they only partly
do: NNP-5E9A2C is approved in the seed and waiting in the mock data, and NNP-9F8E7D and NNP-2A1B0C
are only in the seed. The facts of the sample species were checked on 16 Oct 2026, and 007 has the
fixes. The IUCN statuses come from each species' Wikipedia page, which cites the Red List, the
protection from the Sarawak Forestry Department's list of protected plants, and the names and
where they grow from Kew's Plants of the World Online. SFC should still confirm them, and someone
should check the statuses on the Red List site itself. Kew doesn't list Paphiopedilum barbatum in
Borneo, so SFC should say whether it grows at Niah or should come out of the sample data.

Every sample species is threatened or protected, so none of their plants show an exact spot on
the public site. To see one that does, add a Least Concern species that isn't protected, then
publish a record of it.

## Keys

The website and the app need the project URL and the anon key (Supabase calls it the publishable
key now). Ask Umer for them, then:

- website: copy `web/.env.example` to `web/.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- app: copy `mobile/.env.example` to `mobile/.env` and fill in `EXPO_PUBLIC_SUPABASE_URL` and
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Git ignores both files. Never commit them, and never paste a key into an issue or a pull request.
The anon key is fine in an app, because Row Level Security decides what it can do. The service
role key skips Row Level Security, so it never goes in the app, the website's browser code or git.
The website's server only uses it for inviting, deactivating and listing accounts (item 2), so set
`SUPABASE_SERVICE_ROLE_KEY` as a server environment variable where the website is hosted. Add
`<website address>/welcome` to the Auth redirect URLs too, or invite links open the Site URL
instead.

## When someone leaves the team

An administrator can press Deactivate on the website's Users and roles page. That sets their role
back to `visitor` and stops them signing in, instead of deleting their account. Until the website
has the service role key, set their `role` in the `profiles` table back to `visitor` in the Table
Editor. A visitor can still sign in, but the database won't show them anything a member of the
public can't see, and the website won't open the staff pages for them.

Deleting the account works too. Their records stay, with `submitted_by` cleared, and the history
from 013 still has their name. Their record photos stay in a folder named after the account, and
since 014 each record keeps that folder's name in `photo_folder`, so the record edit page still
shows them and deleting the record deletes them. A record whose account was deleted before 014 was
run has nothing left to say where its photos are, so the website can't show them and they stay in
the bucket.

## Rules from our design

- Row Level Security is on for every table.
- The public reads through `species_public` and `records_public`, never the tables themselves,
  because the records table has exact locations. Only published records show in
  `records_public`, and a plant only shows its exact spot there if its species is Least Concern
  or Near Threatened, isn't protected in Sarawak and isn't set to rough area only, and the record's
  name matches that species. Every other plant, Data Deficient and Not Evaluated ones too, shows
  the middle of its 0.004 degree grid square (about 440 m at Niah) and only the day it was recorded.
- The server decides who uploaded a record and its status, never the phone. See
  [docs/sync-design.md](../docs/sync-design.md).
- A new account is always a visitor, whatever was sent when signing up. Only an admin can change
  someone's role, and never their own.
- Only officers and admins review records. The `fill_in_review` trigger fills in who reviewed a
  record and when, so nobody can review in someone else's name.
- Record photos go in the private `record-photos` bucket, never the public `botanical-photos` one.
- Supabase gives `anon` and `authenticated` every privilege on a new table. Revoke them first,
  then grant only what each role needs, and let Row Level Security pick the rows.
- Every file has to leave the database safe on its own, not just once the last file has run,
  because the hosted project gets them one at a time. `tests/roles.test.js` checks the views after
  each file from 003 on.
- Never edit a file that's been run on the hosted project, because nobody will run it again. Add
  a new numbered file instead, then add it to the table above and to `SQL_FILES` in
  `tests/harness.js`.

## Tests

`tests/` runs our SQL files in order on PGlite (Postgres built for WebAssembly), then acts as each
kind of user to check what they can and can't do. It needs Node 22 (22.13 or newer for
`iot.test.js` and `iot-limit.test.js`, which run `edge-com`), and no Supabase project or keys.

```bash
cd supabase/tests
npm install
npm test
```

- `tests/sync.test.js` checks phone uploads and record photos (item 3) and 010,
  `tests/roles.test.js` checks what each role can read and change (item 4),
  `tests/species.test.js` checks 007 and adding, editing and deleting a species the way the
  website does (item 14), `tests/photos.test.js` checks 009 and saving photos the way the
  website does (item 18), `tests/report-counts.test.js` checks 012 (item 21),
  `tests/history.test.js` checks 013 (items 17 and 18), `tests/photo-folder.test.js` checks
  014 (item 18), `tests/downloads.test.js` checks 011, `tests/species-rough.test.js` checks 015
  (item 19), `tests/phone-reads.test.js` checks what the phone reads back when it syncs (item 10),
  `tests/visitor-reads.test.js` checks the plant info the phone downloads for visitors,
  `tests/iot.test.js` checks the sensor files (016_1 to 017 and 023 to 025) and the `edge-com`
  function (items 28 to 31),
  `tests/public-details.test.js` checks 019, `tests/record-photo-access.test.js` checks 020,
  `tests/role-changes.test.js` checks 021 and `tests/iot-limit.test.js` checks 022 through
  `edge-com` (item 26).
- `tests/stand-in.js` is a stand-in for our Supabase project that runs on your computer, for
  trying the website without a real project. The
  [web README](../web/README.md#trying-sign-in-without-a-supabase-project) says how, and
  `npm run stand-in` starts it on port 54321. It builds the same database as the tests, adds a
  made up account for each role (`officer`, `admin`, `botanist`, `researcher`, `visitor`, and
  `noprofile`, which has no row in `profiles`, all `@example.test`), and answers the parts of the
  Auth, REST and Storage APIs the website uses, as the signed in user. Storage files are kept in
  memory, and the Storage policies from our SQL files decide who can upload, list and delete. The
  password is `TEST_PASSWORD` in `stand-in.js` and only works there. `STAND_IN_PORT` changes the
  port, `STAND_IN_TOKEN_SECONDS` makes a sign in run out sooner, to try refreshing, and
  `STAND_IN_MAX_ROWS` sends fewer rows per read than the usual 1000 (Max rows on Supabase), to
  try the website reading a long list in pages. `STAND_IN_SQL_THROUGH=015` leaves out the SQL files
  after 015, to try the website on a database that's behind. With all the sensor files in, it
  also adds a made up edge device, `NNP-EDGE-01`, with the three sample nodes from 002 on it, runs
  our `edge-com` function at `/functions/v1/edge-com` (an edge on the same computer can upload to
  it with `TEST_DEVICE_TOKEN` from `stand-in.js` as its `edge_key`), and sends it a day of made up
  readings, so the Sensors page starts with an urgent alert, a routine one, one that ended by itself
  and a node that's gone quiet. `STAND_IN_SENSOR_DATA=0` starts with no readings instead. It only
  listens on 127.0.0.1, so other computers can't reach it.
- `tests/edge-com.js` runs `functions/edge-com/index.ts` in Node, for the stand-in and the tests.
  Supabase runs it in Deno, and it only uses `Deno.env` and `Deno.serve` from Deno, so this gives it
  those two and takes out its types with Node's own `stripTypeScriptTypes` (Node 22.13 or newer,
  and it prints an ExperimentalWarning once). Its `npm:postgres` import is swapped for a small
  stand-in for the parts of postgres.js it uses, on the same PGlite database, so it needs no other packages and the code that's tested is
  the code that's deployed. On an older Node the stand-in runs without `edge-com`, and
  `iot.test.js` says why it can't run.
- `tests/stand-in.test.js` checks the stand-in answers like Supabase for the calls the website
  makes, so `npm test` runs it too.
- PGlite runs Postgres 18.3 and Supabase projects run 15 or 17, so don't use anything newer than
  Postgres 15 in our SQL.
- `tests/supabase-stub.sql` stands in for the parts of Supabase our SQL uses (the API roles,
  `auth.uid()` and the Storage tables). If a new file uses another part of Supabase, add it there.
- PGlite doesn't have PostGIS, so the tests take the `postgis` line out of 001. Nothing uses it
  yet.
- `tests/fixtures/phone-upload.json` is shared with the mobile tests, so the phone and the server
  are tested against the same records.
- GitHub runs these tests on every pull request and every push to `main` (the Database job).
