// A stand-in for our Supabase project that runs on this computer, so the website's sign in and
// staff pages can be tried without a real project or real accounts. It builds the same PGlite
// database as the tests (our SQL files in order), adds test accounts and a few made-up records,
// and answers the parts of the Supabase API the website uses: password sign in, refreshing and
// signing out (Auth), reading and changing rows (the REST API), and uploading, deleting and
// showing photos (Storage). Every request runs as the anon or authenticated role with the user's
// ID in the JWT claims, like the real API, so Row Level Security, the grants and the views from
// our SQL files decide what comes back. It also runs our edge-com function (edge-com.js), so an
// edge device on this computer can upload to it, and starts with a day of made-up sensor readings
// so the Sensors page and its map have something to show.
//
// Everything is in memory, so stopping it throws it all away. Never put real data in it.
// web/README.md says how to run the website against it.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { EDGE_COM_RUNS, startEdgeCom } from './edge-com.js';
import { asUser, newDatabase, SQL_FILES } from './harness.js';

/** The anon key the website uses with the stand-in. It only works here. */
export const ANON_KEY = 'stand-in-anon-key';
// Only the website's server has this one, for inviting and deactivating people through Supabase Auth
export const SERVICE_KEY = 'stand-in-service-key';

/**
 * A made up edge device with the sample nodes from 002 on it, so an edge on this computer can
 * upload to /functions/v1/edge-com with no setup: edge_id NNP-EDGE-01 and this token as edge_key in
 * its secrets.toml. The token only works here. A real one comes from the Devices page.
 */
export const TEST_DEVICE_ID = 'NNP-EDGE-01';
export const TEST_DEVICE_TOKEN = 'stand-in-device-token';

/** Every test account uses this password. It only works on the stand-in. */
export const TEST_PASSWORD = 'niah-stand-in';

function testUser(n, login, name, role) {
  const id = `00000000-0000-4000-8000-00000000000${n}`;
  return { id, email: `${login}@example.test`, name, role };
}

/** One test account for each role. The account with no role has its profile row taken out. */
export const TEST_USERS = [
  testUser(1, 'officer', 'Aina Officer', 'conservation_officer'),
  testUser(2, 'admin', 'Badrul Admin', 'admin'),
  testUser(3, 'botanist', 'Chong Botanist', 'botanist'),
  testUser(4, 'researcher', 'Dayang Researcher', 'researcher'),
  testUser(5, 'visitor', 'Elan Visitor', 'visitor'),
  testUser(6, 'noprofile', 'No Profile', null),
];

// Made up for the stand-in, on top of the sample data from 002. The sample species are all
// threatened or protected, so this one is Least Concern and not protected, to show a plant whose
// exact spot is public. The records cover the cases the website has to handle: a species the
// table doesn't have, no height, a dead plant, and records waiting for review or rejected. The
// points are made up near park HQ, like every other sample point.
const TEST_SPECIES = {
  id: 'standinia-exacta',
  slug: 'standinia-exacta',
  scientific_name: 'Standinia exacta',
  family: 'Standiniaceae',
  common_names: ['Stand-in tree'],
  iucn_code: 'LC',
  sarawak_protected: false,
  summary:
    'Made up for the stand-in. It’s Least Concern and not protected, so its plants show their ' +
    'exact spot.',
};

const TEST_RECORDS = [
  {
    id: 'd00d0100-0000-4000-8000-000000000001',
    species_slug: 'standinia-exacta',
    species_name: 'Standinia exacta',
    common_name: 'Stand-in tree',
    height_m: 4.2,
    condition: 'healthy',
    gps: { lat: 3.8152, lng: 113.7791, accuracyM: 5 },
    recorded_at: '2026-10-10T09:15:00Z',
    status: 'published',
  },
  {
    id: 'd00d0200-0000-4000-8000-000000000002',
    species_slug: null,
    species_name: 'Ficus sp.',
    common_name: 'Strangler fig',
    height_m: null,
    condition: 'dead',
    gps: { lat: 3.8133, lng: 113.7802, accuracyM: 8 },
    recorded_at: '2026-10-11T10:30:00Z',
    status: 'published',
  },
  {
    id: 'd00d0300-0000-4000-8000-000000000003',
    species_slug: 'koompassia-excelsa',
    species_name: 'Koompassia excelsa',
    common_name: 'Tapang',
    height_m: 31,
    condition: 'diseased',
    gps: { lat: 3.812, lng: 113.7811, accuracyM: 7 },
    recorded_at: '2026-10-12T08:05:00Z',
    status: 'waiting',
  },
  {
    id: 'd00d0400-0000-4000-8000-000000000004',
    species_slug: 'standinia-exacta',
    species_name: 'Standinia exacta',
    common_name: 'Stand-in tree',
    height_m: 2.5,
    condition: 'damaged',
    gps: { lat: 3.816, lng: 113.777, accuracyM: 15 },
    recorded_at: '2026-10-12T14:40:00Z',
    status: 'rejected',
    review_notes: 'The photos are too blurry to tell the species.',
  },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
// Maps, not plain objects, so a word like constructor or toString isn't a filter by accident
const FILTERS = new Map([
  ['eq', '='],
  ['neq', '<>'],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
  ['like', 'LIKE'],
  ['ilike', 'ILIKE'],
]);
const ORDER_WORDS = new Map([
  ['asc', 'ASC'],
  ['desc', 'DESC'],
  ['nullsfirst', 'NULLS FIRST'],
  ['nullslast', 'NULLS LAST'],
]);
// The words in a REST query string that aren't filters
const NOT_FILTERS = new Set(['select', 'order', 'limit', 'offset', 'columns']);

/**
 * Starts the stand-in and gives back its URL and a close() for stopping it. Port 0 picks any free
 * port, which the tests use. tokenSeconds is how long a sign in lasts before the website has to
 * refresh it, an hour like Supabase unless it's made shorter to try refreshing. maxRows is the most
 * rows one read sends back, 1000 like Max rows on Supabase unless it's made smaller to try reading
 * a long list in pages.
 */
export async function startStandIn({
  host = '127.0.0.1',
  port = 54321,
  tokenSeconds = 3600,
  maxRows = 1000,
  log = console.log,
  // The last SQL file to run, like '015', to try the website before the newer files are on hosted
  sqlThrough = null,
  // A day of made-up readings and alerts from the sample nodes. The tests turn it off to start empty
  sensorData = true,
} = {}) {
  const sqlFiles = sqlThrough ? SQL_FILES.filter((file) => file.slice(0, 3) <= sqlThrough) : SQL_FILES;
  const db = await newDatabase(sqlFiles);
  await addTestData(db);
  // edge-com needs every sensor file, 016_1 to 025. Without them it isn't there, like a project
  // where it hasn't been deployed.
  const sensors = IOT_FILES.every((file) => sqlFiles.includes(file));
  let edgeCom = null;
  if (sensors) {
    await addTestDevice(db);
    if (EDGE_COM_RUNS) {
      edgeCom = await startEdgeCom(db, { output: { log, warn: log, error: log } });
      if (sensorData) await addSensorData(db, edgeCom);
    } else {
      log('edge-com needs Node 22.13 or newer, so the stand-in runs without it and its sensor data');
    }
  }

  // The API's schema cache: the columns of every table and view in public
  const columns = new Map();
  const { rows } = await db.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  for (const row of rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
    columns.get(row.table_name).add(row.column_name);
  }
  // ... and the functions in public that /rest/v1/rpc/ can call, with each argument's type
  const functions = new Map();
  const listed = await db.query(
    `SELECT p.proname AS name, p.proargnames AS args,
       array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t) AS types
     FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'`,
  );
  for (const row of listed.rows) {
    functions.set(row.name, new Map((row.args ?? []).map((arg, i) => [arg, row.types[i]])));
  }

  // PGlite has one connection, so requests take turns
  let queue = Promise.resolve();
  const oneAtATime = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const auth = new Auth(tokenSeconds, db, oneAtATime, log);
  // Uploaded files, by bucket and path. storage.objects keeps who uploaded them, like on Supabase
  const files = new Map();
  // Signs links to private files. A new one each run, so old links stop working
  const linkSecret = randomBytes(32);

  const server = createServer((req, res) => {
    const ctx = { auth, columns, db, edgeCom, files, functions, linkSecret, maxRows, oneAtATime };
    handle(req, res, ctx)
      .catch((error) => {
        console.error(error);
        if (!res.headersSent) send(res, 500, { message: 'The stand-in broke. See its terminal.' });
      })
      .finally(() => log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode}`));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    url: `http://${host}:${server.address().port}`,
    db,
    // Whether edge-com is running, which it is when every sensor file is
    edgeCom: edgeCom !== null,
    // Every email Auth would have sent, oldest first, so tests can follow the links
    emails: auth.emails,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await edgeCom?.close();
      await db.close();
    },
  };
}

// The sensor files, 016_1 to 025
const IOT_FILES = SQL_FILES.filter((file) => file.includes('_iot_'));

async function addTestDevice(db) {
  await db.query(
    `INSERT INTO public.iot_devices (device_id, name, zone, latitude, longitude)
     VALUES ($1, $2, $3, $4, $5)`,
    [TEST_DEVICE_ID, 'Stand-in edge device', 'Made up region', 3.8143, 113.7795],
  );
  await db.query('INSERT INTO public.iot_device_tokens (device_id, token_hash) VALUES ($1, $2)', [
    TEST_DEVICE_ID,
    createHash('sha256').update(TEST_DEVICE_TOKEN).digest(),
  ]);
  await db.query('UPDATE public.iot_nodes SET edge_device_id = $1', [TEST_DEVICE_ID]);
}

// The made-up sensor data: a reading every 10 minutes for the last day from the first three sample
// nodes, each placed a little way from park HQ like every other sample point. They go in through
// edge-com, so the alerts come from the same rules as on Supabase:
//   the first node's soil has been waterlogged for the last 20 minutes (an urgent alert going on),
//   the second also raises RAIN, and has light rain now (a routine one going on) and was moved for
//     10 minutes before that (an alert that ended by itself and nobody has resolved),
//   the third stopped sending 3 hours ago (QUIET).
// The numbers follow a day in the forest but aren't from a real node.
const SAMPLE_PLACES = [
  { lat: 3.8157, lng: 113.7786, soil: 2650, distance: 120 },
  { lat: 3.8136, lng: 113.7811, soil: 2900, distance: 95 },
  { lat: 3.8125, lng: 113.778, soil: 2500, distance: 140 },
];
const TEN_MINUTES = 600;

// The same wobble every run, so the sample looks the same each time
function wobble(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

async function addSensorData(db, edgeCom) {
  const { rows: nodes } = await db.query(
    'SELECT node_id FROM public.iot_nodes ORDER BY node_id LIMIT $1',
    [SAMPLE_PLACES.length],
  );
  if (nodes[1]) {
    await db.query(
      `UPDATE public.iot_nodes SET alert_types = array_append(alert_types, 'RAIN') WHERE node_id = $1`,
      [nodes[1].node_id],
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const batch = { edge_id: TEST_DEVICE_ID, nodes: [], boots: [] };
  nodes.forEach(({ node_id: node }, n) => {
    const place = SAMPLE_PLACES[n];
    const bootId = 1_000_000_000 + n * 7919;
    // From a day ago to 10 minutes ago, then one a minute ago. The third node stops 3 hours ago
    const times = [];
    for (let at = now - 24 * 3600; at <= now - TEN_MINUTES; at += TEN_MINUTES) times.push(at);
    times.push(now - 60);
    const sent = n === 2 ? times.filter((at) => at <= now - 3 * 3600) : times;
    const rows = sent.map((at, i) => {
      const ago = (now - at) / 60;
      const seed = n * 1000 + i;
      // Malaysian time of day, coolest before dawn and warmest mid afternoon
      const hour = (((at / 3600 + 8) % 24) + 24) % 24;
      const warmth = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      // An afternoon shower on the first and third nodes, which don't raise RAIN
      const shower = n !== 1 && hour >= 15 && hour < 16.5;
      let soil = place.soil + Math.round(wobble(seed) * 40) - (shower ? 220 : 0);
      let rain = shower ? 2900 + Math.round(wobble(seed + 1) * 120) : 4095;
      let distance = place.distance + Math.round(wobble(seed + 2) * 8) / 10;
      if (n === 0 && ago <= 20) soil = 1670 + Math.round(wobble(seed) * 20);
      if (n === 1 && ago <= 50 && ago > 35) distance = place.distance + 15;
      if (n === 1 && ago <= 20) rain = 3316 + Math.round(wobble(seed + 1) * 30);
      return [
        i + 1, // seq
        at, // when it was measured
        1, // lag: the edge got it a second later
        Math.round((26.5 + 3.5 * warmth + wobble(seed + 3)) * 10) / 10, // temp_c
        Math.round(86 - 9 * warmth + wobble(seed + 4) * 4), // hum_pct
        soil,
        rain,
        distance,
        place.distance, // baseline_cm
        0, // beep_on
        -64 + Math.round(wobble(seed + 5) * 12), // rssi
        0, // motion
      ];
    });
    batch.nodes.push({ node_id: node, boot_id: bootId, rows });
    batch.boots.push({
      node_id: node,
      boot_id: bootId,
      lat: place.lat,
      lon: place.lng,
      at: new Date(sent[0] * 1000).toISOString(),
    });
  });
  const response = await edgeCom.upload(TEST_DEVICE_TOKEN, batch);
  if (!response.ok) throw new Error(`The sample readings didn't go in: ${await response.text()}`);

  // The first node was found with its locate beep two hours ago, by the test officer
  if (!nodes[0]) return;
  const officer = TEST_USERS.find((user) => user.role === 'conservation_officer');
  for (const [command, minutesAgo] of [
    ['beep_on', 125],
    ['beep_off', 110],
  ]) {
    const { rows } = await asUser(db, officer, (tx) =>
      tx.query('INSERT INTO public.iot_commands (node_id, command) VALUES ($1, $2) RETURNING id', [
        nodes[0].node_id,
        command,
      ]),
    );
    await db.query(
      `UPDATE public.iot_commands
       SET status = 'done', result = 'ok', created_at = now() - make_interval(mins => $2),
         at_edge_at = now() - make_interval(mins => $2) + interval '20 seconds',
         sent_at = now() - make_interval(mins => $2) + interval '21 seconds',
         done_at = now() - make_interval(mins => $2) + interval '23 seconds'
       WHERE id = $1`,
      [rows[0].id, minutesAgo],
    );
  }
}

async function addTestData(db) {
  for (const user of TEST_USERS) {
    // Signs up the way Supabase Auth does, so the trigger from 004 makes a visitor profile
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      user.id,
      user.email,
      JSON.stringify({ name: user.name }),
    ]);
    if (user.role === null) {
      await db.query('DELETE FROM public.profiles WHERE id = $1', [user.id]);
    } else if (user.role !== 'visitor') {
      await db.query('UPDATE public.profiles SET role = $1 WHERE id = $2', [user.role, user.id]);
    }
  }
  await db.query(
    `INSERT INTO public.species (id, slug, scientific_name, family, common_names, iucn_code,
       sarawak_protected, summary)
     SELECT id, slug, scientific_name, family, common_names, iucn_code, sarawak_protected, summary
     FROM json_populate_record(null::public.species, $1::json)`,
    [JSON.stringify(TEST_SPECIES)],
  );
  for (const record of TEST_RECORDS) {
    await db.query(
      `INSERT INTO public.records (id, species_slug, species_name, common_name, height_m,
         condition, gps, recorded_by, recorded_at, status, review_notes)
       SELECT id, species_slug, species_name, common_name, height_m, condition, gps,
         'Stand-in', recorded_at, status, review_notes
       FROM json_populate_record(null::public.records, $1::json)`,
      [JSON.stringify(record)],
    );
  }
}

async function handle(req, res, ctx) {
  // Lets a page in a browser call the stand-in too, like it can call Supabase
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
  if (req.method === 'OPTIONS') return send(res, 204);

  const url = new URL(req.url, 'http://stand-in');
  // Supabase Edge Functions. edge-com has JWT verification turned off, so an edge only sends its
  // own token, without the anon key
  if (url.pathname.startsWith('/functions/v1/')) return edgeFunction(req, res, url, ctx);

  // Public and signed photo links work without the anon key, because an <img> can't send one
  const link = /^\/storage\/v1\/object\/(public|sign)\//.exec(url.pathname);
  if (link && (link[1] === 'public' || req.method === 'GET' || req.method === 'HEAD')) {
    return openFile(req, res, url, link[1], ctx);
  }

  // The link in an email opens in a browser, so it has no API key
  if (req.method === 'GET' && url.pathname === '/auth/v1/verify') {
    return ctx.auth.verify(res, url);
  }

  if (!req.headers.apikey) return send(res, 401, { message: 'No API key found in request' });
  if (req.headers.apikey !== ANON_KEY && req.headers.apikey !== SERVICE_KEY) {
    return send(res, 401, { message: 'Invalid API key' });
  }
  // On Supabase this key skips Row Level Security. The website must not use it for rows or files,
  // so here it fails loudly instead of hiding a mistake.
  if (req.headers.apikey === SERVICE_KEY && !url.pathname.startsWith('/auth/v1/')) {
    return send(res, 403, { message: 'The stand-in only takes the service key for Supabase Auth' });
  }

  // Storage takes files, so it reads its own bodies
  if (url.pathname.startsWith('/storage/v1/')) {
    try {
      return await storage(req, res, url, ctx);
    } catch (error) {
      if (error instanceof Refusal) {
        return storageError(res, error.status, error.body.code, error.body.message);
      }
      throw error;
    }
  }

  const { body, status, message } = await readBody(req);
  if (status) return send(res, status, { message });

  if (url.pathname.startsWith('/auth/v1/')) {
    return ctx.auth.handle(req, res, url.pathname.slice('/auth/v1'.length), url, body);
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    try {
      return await rest(req, res, url, body, ctx);
    } catch (error) {
      if (error instanceof Refusal) return send(res, error.status, error.body);
      throw error;
    }
  }
  return send(res, 404, { message: 'no Route matched with those values' });
}

/** Reads a JSON body. The body is null when there isn't one. */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  // Reads to the end even when it's too big, so the answer still gets back on the same connection
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 1_000_000) chunks.push(chunk);
  }
  if (size > 1_000_000) return { status: 413, message: 'The body is over 1 MB' };
  // Joined as bytes first, so a character split between two chunks comes out whole
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return { body: null };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { status: 400, message: 'The body isn’t JSON' };
  }
}

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function bearerOf(req) {
  const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

// ----- Edge Functions -----

// Supabase takes a request body of up to 20 MB. edge-com has its own, smaller, limit after it
// unzips one.
const FUNCTION_BODY_LIMIT = 20 * 1024 * 1024;
// Headers that are about this connection, not the request, so they don't go on to edge-com
const HOP_HEADERS = new Set(['connection', 'content-length', 'host', 'keep-alive', 'transfer-encoding']);

/** /functions/v1/edge-com, handed to our edge-com function the way Supabase does. */
async function edgeFunction(req, res, url, { edgeCom, oneAtATime }) {
  const chunks = [];
  let size = 0;
  // Reads to the end even when it's too big, so the answer still gets back on the same connection
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= FUNCTION_BODY_LIMIT) chunks.push(chunk);
  }
  if (url.pathname !== '/functions/v1/edge-com' || !edgeCom) {
    return send(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
  }
  if (size > FUNCTION_BODY_LIMIT) return send(res, 413, { message: 'The body is over 20 MB' });

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) headers.set(name, [value].flat().join(', '));
  }
  const reading = req.method === 'GET' || req.method === 'HEAD';
  const request = new Request(`http://stand-in${req.url}`, {
    method: req.method,
    headers,
    body: reading ? undefined : Buffer.concat(chunks),
  });
  // PGlite has one connection, so edge-com takes its turn with the API's requests
  const response = await oneAtATime(() => edgeCom.handle(request));
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  return res.end(body);
}

// ----- Auth -----

class Auth {
  constructor(tokenSeconds, db, oneAtATime, log) {
    this.tokenSeconds = tokenSeconds;
    this.db = db;
    this.oneAtATime = oneAtATime;
    this.log = log;
    // A new secret each run, so a cookie from an earlier run is a bad JWT, like after a restart
    // with a new JWT secret on Supabase
    this.secret = randomBytes(32);
    // The sessions that are signed in, with their user's ID
    this.sessions = new Map();
    // Every refresh token given out, with its session, when it was used and the one after it
    this.refreshTokens = new Map();
    // Accounts made by an invite, by ID. The test accounts are in TEST_USERS
    this.invited = new Map();
    // What's changed about an account since it was made, by ID: when it's banned until, when it
    // last signed in
    this.changes = new Map();
    // Links in emails that haven't been used, by token, and every email Auth would have sent
    this.links = new Map();
    this.emails = [];
  }

  handle(req, res, path, url, body) {
    const grant = url.searchParams.get('grant_type');
    if (req.method === 'POST' && path === '/token' && grant === 'password') {
      const user = this.signingIn(body?.email, body?.password);
      if (!user) return authError(res, 400, 'invalid_credentials', 'Invalid login credentials');
      if (this.isBanned(user.id)) return authError(res, 400, 'user_banned', 'User is banned');
      this.change(user.id, { lastSignIn: new Date().toISOString() });
      return send(res, 200, this.newSession(user));
    }
    if (req.method === 'POST' && path === '/token' && grant === 'refresh_token') {
      return this.refresh(res, body?.refresh_token);
    }
    if (req.method === 'GET' && path === '/user') {
      const checked = this.check(bearerOf(req));
      if (!checked.user) return authError(res, checked.status, checked.code, checked.error);
      return send(res, 200, this.json(checked.user));
    }
    if (req.method === 'PUT' && path === '/user') {
      return this.setPassword(req, res, body);
    }
    if (req.method === 'POST' && path === '/recover') {
      return this.recover(req, res, url, body);
    }
    if (req.method === 'POST' && path === '/invite') {
      if (bearerOf(req) !== SERVICE_KEY) return notAdmin(res);
      return this.invite(req, res, url, body);
    }
    if (req.method === 'GET' && path === '/admin/users') {
      if (bearerOf(req) !== SERVICE_KEY) return notAdmin(res);
      const users = [...TEST_USERS, ...this.invited.values()].map((u) => this.json(u));
      return send(res, 200, { users, aud: 'authenticated' });
    }
    const adminUser = /^\/admin\/users\/([^/]+)$/.exec(path);
    if (req.method === 'PUT' && adminUser) {
      if (bearerOf(req) !== SERVICE_KEY) return notAdmin(res);
      return this.updateByAdmin(res, adminUser[1], body);
    }
    if (req.method === 'POST' && path === '/logout') {
      const checked = this.check(bearerOf(req));
      if (!checked.user) return authError(res, checked.status, checked.code, checked.error);
      this.signOut(checked.claims, url.searchParams.get('scope') ?? 'global');
      return send(res, 204);
    }
    if (req.method === 'POST' && path === '/signup') {
      // Like our project with "Allow new users to sign up" turned off
      return authError(res, 422, 'signup_disabled', 'Signups not allowed for this instance');
    }
    return authError(res, 404, 'not_found', 'The stand-in doesn’t have this part of Supabase Auth');
  }

  userById(id) {
    return TEST_USERS.find((u) => u.id === id) ?? this.invited.get(id);
  }

  userByEmail(email) {
    const wantedEmail = String(email ?? '').toLowerCase();
    return (
      TEST_USERS.find((u) => u.email === wantedEmail) ??
      [...this.invited.values()].find((u) => u.email === wantedEmail)
    );
  }

  /** The test accounts share one password. Invited accounts have the one they set. */
  signingIn(email, password) {
    const user = this.userByEmail(email);
    if (!user?.invited) return findUser(email, password);
    return user.password && user.password === String(password ?? '') ? user : null;
  }

  change(id, changes) {
    this.changes.set(id, { ...this.changes.get(id), ...changes });
  }

  isBanned(id) {
    const until = this.changes.get(id)?.bannedUntil;
    return Boolean(until) && Date.parse(until) > Date.now();
  }

  json(user) {
    return userJson(user, this.changes.get(user.id));
  }

  /** Writes the email Supabase would send. Prints it, because nothing here really sends email. */
  sendLink(req, url, user, type) {
    for (const [token, link] of this.links) {
      if (link.userId === user.id) this.links.delete(token);
    }
    const token = randomBytes(16).toString('hex');
    this.links.set(token, { userId: user.id, type, expires: Date.now() + 24 * 3600 * 1000 });
    const redirectTo = url.searchParams.get('redirect_to') ?? `http://${req.headers.host}/`;
    const query = new URLSearchParams({ token, type, redirect_to: redirectTo });
    const link = `http://${req.headers.host}/auth/v1/verify?${query}`;
    this.emails.push({ to: user.email, type, link });
    this.log(`Email to ${user.email} (${type}): ${link}`);
  }

  // Makes the account the way Supabase Auth does, so the trigger from 004 makes a visitor profile.
  // Inviting an email that's already in use only works again if they never finished signing up.
  async invite(req, res, url, body) {
    const email = String(body?.email ?? '').toLowerCase();
    if (!email.includes('@')) {
      return authError(res, 400, 'validation_failed', 'Unable to validate email address');
    }
    let user = this.userByEmail(email);
    if (user && (!user.invited || this.changes.get(user.id)?.confirmedAt)) {
      return authError(res, 422, 'email_exists',
        'A user with this email address has already been registered');
    }
    if (!user) {
      const name = body?.data?.name ?? null;
      user = {
        id: randomUUID(),
        email,
        name,
        invited: true,
        password: null,
        createdAt: new Date().toISOString(),
      };
      await this.oneAtATime(() =>
        this.db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
          user.id,
          email,
          JSON.stringify(body?.data ?? {}),
        ]),
      );
      this.invited.set(user.id, user);
    }
    this.sendLink(req, url, user, 'invite');
    return send(res, 200, this.json(user));
  }

  // Says yes for an email with no account too, like on Supabase, so it can't be used to find them
  recover(req, res, url, body) {
    const user = this.userByEmail(body?.email);
    if (user) this.sendLink(req, url, user, 'recovery');
    return send(res, 200, {});
  }

  /** A link from an email. Goes back to the site with a session after the #, or what went wrong. */
  verify(res, url) {
    const link = this.links.get(url.searchParams.get('token'));
    const type = url.searchParams.get('type');
    const back = new URL(url.searchParams.get('redirect_to') ?? 'http://127.0.0.1:3210/');
    const goBack = (values) => {
      back.hash = new URLSearchParams(values).toString();
      return send(res, 303, undefined, { Location: back.href });
    };
    if (!link || link.type !== type || link.expires <= Date.now()) {
      return goBack({
        error: 'access_denied',
        error_code: 'otp_expired',
        error_description: 'Email link is invalid or has expired',
      });
    }
    if (this.isBanned(link.userId)) {
      return goBack({
        error: 'access_denied',
        error_code: 'user_banned',
        error_description: 'User is banned',
      });
    }
    this.links.delete(url.searchParams.get('token'));
    const now = new Date().toISOString();
    this.change(link.userId, { confirmedAt: now, lastSignIn: now });
    const session = this.newSession(this.userById(link.userId));
    return goBack({
      access_token: session.access_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      refresh_token: session.refresh_token,
      token_type: 'bearer',
      type,
    });
  }

  setPassword(req, res, body) {
    const checked = this.check(bearerOf(req));
    if (!checked.user) return authError(res, checked.status, checked.code, checked.error);
    const password = String(body?.password ?? '');
    if (password.length < 6) {
      return authError(res, 422, 'weak_password', 'Password should be at least 6 characters');
    }
    // The test accounts share one password, so that doesn't change
    if (!checked.user.invited) {
      return authError(res, 422, 'validation_failed', 'The stand-in can’t change a test account');
    }
    if (checked.user.password === password) {
      return authError(res, 422, 'same_password',
        'New password should be different from the old password');
    }
    checked.user.password = password;
    return send(res, 200, this.json(checked.user));
  }

  updateByAdmin(res, id, body) {
    const user = this.userById(id);
    if (!user) return authError(res, 404, 'user_not_found', 'User not found');
    const duration = body?.ban_duration;
    if (duration === 'none') {
      this.change(id, { bannedUntil: null });
    } else if (/^\d+h$/.test(duration ?? '')) {
      const until = Date.now() + Number.parseInt(duration, 10) * 3600 * 1000;
      this.change(id, { bannedUntil: new Date(until).toISOString() });
    } else {
      return authError(res, 400, 'validation_failed', 'The stand-in only changes ban_duration');
    }
    return send(res, 200, this.json(user));
  }

  newSession(user, sessionId = randomUUID(), refreshToken = null) {
    this.sessions.set(sessionId, user.id);
    if (!refreshToken) {
      refreshToken = randomBytes(12).toString('base64url');
      this.refreshTokens.set(refreshToken, { sessionId, usedAt: null, next: null });
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      aud: 'authenticated',
      exp: now + this.tokenSeconds,
      iat: now,
      iss: 'stand-in',
      sub: user.id,
      email: user.email,
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { name: user.name },
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
      session_id: sessionId,
      is_anonymous: false,
    };
    return {
      access_token: this.sign(claims),
      token_type: 'bearer',
      expires_in: this.tokenSeconds,
      expires_at: claims.exp,
      refresh_token: refreshToken,
      user: this.json(user),
    };
  }

  // A refresh token works once, like on Supabase. Using it again within 10 seconds gives the
  // token that came after it, because two requests can refresh at the same time. After that it
  // signs the whole session out, because someone else may have the token.
  refresh(res, token) {
    const found = this.refreshTokens.get(token);
    const userId = found && this.sessions.get(found.sessionId);
    if (!userId) {
      return authError(res, 400, 'refresh_token_not_found',
        'Invalid Refresh Token: Refresh Token Not Found');
    }
    const user = this.userById(userId);
    if (this.isBanned(userId)) return authError(res, 400, 'user_banned', 'User is banned');
    if (found.usedAt === null) {
      const session = this.newSession(user, found.sessionId);
      found.usedAt = Date.now();
      found.next = session.refresh_token;
      return send(res, 200, session);
    }
    if (Date.now() - found.usedAt <= 10_000) {
      return send(res, 200, this.newSession(user, found.sessionId, found.next));
    }
    this.sessions.delete(found.sessionId);
    return authError(res, 400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
  }

  signOut(claims, scope) {
    for (const [sessionId, userId] of this.sessions) {
      if (userId !== claims.sub) continue;
      const same = sessionId === claims.session_id;
      if (scope === 'global' || (scope === 'local' && same) || (scope === 'others' && !same)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  sign(claims) {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
    return `${unsigned}.${createHmac('sha256', this.secret).update(unsigned).digest('base64url')}`;
  }

  /**
   * Checks a JWT the way Supabase Auth does. Gives its claims and user, or what's wrong with it.
   * A signed out session still gives the claims, because the REST API doesn't check sessions.
   */
  check(token) {
    if (!token) {
      return {
        status: 401,
        code: 'no_authorization',
        error: 'This endpoint requires a Bearer token',
      };
    }
    const bad = {
      status: 403,
      code: 'bad_jwt',
      error: 'invalid JWT: unable to parse or verify signature',
    };
    const parts = token.split('.');
    if (parts.length !== 3) return bad;
    const expected = createHmac('sha256', this.secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return bad;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims.exp * 1000 <= Date.now()) {
      const error = 'invalid JWT: unable to parse or verify signature, token has expired';
      return { ...bad, error, expired: true };
    }
    if (!this.sessions.has(claims.session_id)) {
      return {
        status: 403,
        code: 'session_not_found',
        error: 'Session from session_id claim in JWT does not exist',
        claims,
      };
    }
    const user = this.userById(claims.sub);
    return user ? { claims, user } : bad;
  }
}

function findUser(email, password) {
  // Capitals don't matter in an email, like on Supabase. The website takes out spaces itself.
  const user = TEST_USERS.find((u) => u.email === String(email ?? '').toLowerCase());
  const given = Buffer.from(String(password ?? ''));
  const wanted = Buffer.from(TEST_PASSWORD);
  const right = given.length === wanted.length && timingSafeEqual(given, wanted);
  return user && right ? user : null;
}

function userJson(user, changes = {}) {
  const at = user.createdAt ?? '2026-10-01T00:00:00Z';
  const confirmed = user.invited ? changes.confirmedAt : at;
  const lastSignIn = changes.lastSignIn ?? (user.invited ? undefined : at);
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    ...(confirmed ? { email_confirmed_at: confirmed, confirmed_at: confirmed } : {}),
    ...(user.invited ? { invited_at: at } : {}),
    ...(changes.bannedUntil ? { banned_until: changes.bannedUntil } : {}),
    phone: '',
    ...(lastSignIn ? { last_sign_in_at: lastSignIn } : {}),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { name: user.name },
    identities: [],
    created_at: at,
    updated_at: at,
    is_anonymous: false,
  };
}

function authError(res, status, code, msg) {
  return send(res, status, { code: status, error_code: code, msg });
}

function notAdmin(res) {
  return authError(res, 403, 'not_admin', 'User not allowed');
}

// ----- REST API -----

/** An error the REST API sends back, with its HTTP status. */
class Refusal extends Error {
  constructor(status, code, message, details = null, hint = null) {
    super(message);
    this.status = status;
    this.body = { code, details, hint, message };
  }
}

/** The HTTP status the REST API gives for a Postgres error code, from PostgREST's table. */
function statusFor(code, signedIn) {
  // A code like PT429 picks the status itself
  if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
  if (code === '42501') return signedIn ? 403 : 401;
  if (code === '23503' || code === '23505') return 409;
  if (code === '42P01' || code === '42883') return 404;
  if (code === '25006') return 405;
  if (code === 'P0001') return 400;
  const start = code.slice(0, 2);
  if (['08', '53'].includes(start)) return 503;
  if (start === '54') return 413;
  if (['0L', '0P', '28'].includes(start)) return 403;
  if (['09', '25', '2D', '38', '39', '3B', '40', '55', '57', '58'].includes(start)) return 500;
  if (['F0', 'HV', 'P0', 'XX'].includes(start)) return 500;
  return 400;
}

/** Who a REST request is from: null for the anon key, or the signed in user in the JWT. */
function whoIsAsking(req, auth) {
  const token = bearerOf(req);
  if (!token || token === ANON_KEY) return null;
  const checked = auth.check(token);
  // The REST API only checks the JWT itself, not the session, so a JWT still works after its
  // user signs out, until it runs out, like on Supabase
  if (checked.claims) return { id: checked.claims.sub };
  if (checked.expired) throw new Refusal(401, 'PGRST303', 'JWT expired');
  throw new Refusal(401, 'PGRST301', 'JWT could not be decoded');
}

function selectFrom(select, column) {
  if (!select || select === '*') return '*';
  return select
    .split(',')
    .map((name) => (name === '*' ? '*' : column(name)))
    .join(', ');
}

/** Turns filters like id=eq.123 into SQL, with their values as $1 style parameters. */
function whereFrom(searchParams, column, params) {
  const where = [];
  for (const [name, value] of searchParams) {
    if (NOT_FILTERS.has(name)) continue;
    if (name === 'or' || name === 'and') {
      throw new Refusal(400, 'PGRST100', 'The stand-in doesn’t do or() and and() filters');
    }
    const negate = value.startsWith('not.');
    const filter = negate ? value.slice('not.'.length) : value;
    const dot = filter.indexOf('.');
    const op = dot === -1 ? filter : filter.slice(0, dot);
    const arg = dot === -1 ? null : filter.slice(dot + 1);
    let sql;
    if (FILTERS.has(op) && arg !== null) {
      params.push(op.endsWith('like') ? arg.replaceAll('*', '%') : arg);
      sql = `${column(name)} ${FILTERS.get(op)} $${params.length}`;
    } else if (op === 'is' && ['null', 'true', 'false'].includes(arg)) {
      sql = `${column(name)} IS ${arg.toUpperCase()}`;
    } else if (op === 'in' && arg === '()') {
      column(name);
      sql = 'false';
    } else if (op === 'in' && /^\(.+\)$/.test(arg ?? '')) {
      const items = arg.slice(1, -1).split(',').map((item) => item.replace(/^"(.*)"$/, '$1'));
      sql = `${column(name)} IN (${items.map((item) => `$${params.push(item)}`).join(', ')})`;
    } else {
      throw new Refusal(400, 'PGRST100', `The stand-in doesn’t understand ${name}=${value}`);
    }
    where.push(negate ? `NOT (${sql})` : sql);
  }
  return where.length ? ` WHERE ${where.join(' AND ')}` : '';
}

/** Turns order=recorded_at.desc,name.asc.nullslast into SQL. */
function orderFrom(order, column) {
  if (!order) return '';
  const terms = order.split(',').map((term) => {
    const [name, ...words] = term.split('.');
    const sql = words.map((word) => {
      if (!ORDER_WORDS.has(word)) {
        throw new Refusal(400, 'PGRST100', `The stand-in doesn’t understand order=${order}`);
      }
      return ORDER_WORDS.get(word);
    });
    return [column(name), ...sql].join(' ');
  });
  return ` ORDER BY ${terms.join(', ')}`;
}

/** Turns limit and offset into SQL. A read never gets more than maxRows rows, like on Supabase. */
function pageFrom(searchParams, maxRows = null) {
  const asked = {};
  for (const word of ['limit', 'offset']) {
    const value = searchParams.get(word);
    if (value === null) continue;
    if (!/^\d+$/.test(value)) {
      throw new Refusal(400, 'PGRST100', `${word} has to be a whole number`);
    }
    asked[word] = Number(value);
  }
  const limit = maxRows === null ? asked.limit : Math.min(asked.limit ?? maxRows, maxRows);
  return (limit === undefined ? '' : ` LIMIT ${limit}`) +
    (asked.offset === undefined ? '' : ` OFFSET ${asked.offset}`);
}

/** The columns a POST or PATCH body sets, checked against the schema cache like the API does. */
function columnsToSet(method, body, table, known) {
  const rows = Array.isArray(body) ? body : [body];
  const isObject = (row) => row !== null && typeof row === 'object' && !Array.isArray(row);
  if (!rows.length || !rows.every(isObject)) {
    throw new Refusal(400, 'PGRST102', 'The body has to be a JSON object or a list of them');
  }
  if (method === 'PATCH' && rows.length !== 1) {
    throw new Refusal(400, 'PGRST102', 'An update takes one JSON object');
  }
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!names.length) throw new Refusal(400, 'PGRST102', 'The body doesn’t have any columns');
  for (const name of names) {
    if (!IDENT.test(name) || !known.has(name)) {
      throw new Refusal(400, 'PGRST204',
        `Could not find the '${name}' column of '${table}' in the schema cache`);
    }
  }
  return { names: names.map((name) => `"${name}"`).join(', '), json: JSON.stringify(rows) };
}

async function rest(req, res, url, body, { auth, columns, db, functions, maxRows, oneAtATime }) {
  // The API checks the JWT before anything else
  const user = whoIsAsking(req, auth);
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    return rpc(req, res, url, body, user, { db, functions, oneAtATime });
  }

  const table = url.pathname.slice('/rest/v1/'.length);
  if (!IDENT.test(table) || !columns.has(table)) {
    throw new Refusal(404, 'PGRST205',
      `Could not find the table 'public.${table}' in the schema cache`);
  }
  const known = columns.get(table);
  const column = (name) => {
    if (!IDENT.test(name) || !known.has(name)) {
      throw new Refusal(400, '42703', `column ${table}.${name} does not exist`);
    }
    return `"${name}"`;
  };

  const method = req.method;
  const reading = method === 'GET' || method === 'HEAD';
  const params = [];
  const selectSql = selectFrom(url.searchParams.get('select'), column);
  const whereSql = whereFrom(url.searchParams, column, params);
  const orderSql = orderFrom(url.searchParams.get('order'), column);
  const pageSql = pageFrom(url.searchParams, reading ? maxRows : null);
  if (!reading && (orderSql || pageSql)) {
    throw new Refusal(400, 'PGRST100', 'The stand-in only takes order, limit and offset on reads');
  }

  const prefer = String(req.headers.prefer ?? '');
  if (prefer.includes('resolution=')) {
    throw new Refusal(400, 'PGRST100', 'The stand-in can’t upsert');
  }
  const wantsRows = prefer.includes('return=representation');
  const wantsCount = prefer.includes('count=exact');
  // .single() asks for one object instead of a list
  const oneObject = String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');

  const target = `public."${table}"`;
  const returning = wantsRows ? ` RETURNING ${selectSql}` : '';
  let sql;
  if (reading) {
    sql = `SELECT ${selectSql} FROM ${target}${whereSql}${orderSql}${pageSql}`;
  } else if (method === 'POST') {
    if (whereSql) throw new Refusal(400, 'PGRST100', 'An insert doesn’t take filters');
    const set = columnsToSet(method, body, table, known);
    params.push(set.json);
    sql = `INSERT INTO ${target} (${set.names})
      SELECT ${set.names} FROM json_populate_recordset(null::${target}, $${params.length}::json)
      ${returning}`;
  } else if (method === 'PATCH' || method === 'DELETE') {
    // Supabase won't change or delete every row of a table by accident either
    const verb = method === 'PATCH' ? 'UPDATE' : 'DELETE';
    if (!whereSql) throw new Refusal(400, '21000', `${verb} requires a WHERE clause`);
    if (method === 'PATCH') {
      const set = columnsToSet(method, body, table, known);
      params.push(set.json);
      sql = `UPDATE ${target} SET (${set.names}) = (
        SELECT ${set.names} FROM json_populate_recordset(null::${target}, $${params.length}::json)
      )${whereSql}${returning}`;
    } else {
      sql = `DELETE FROM ${target}${whereSql}${returning}`;
    }
  } else {
    throw new Refusal(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
  }

  let rows;
  let total = null;
  try {
    ({ rows, total } = await oneAtATime(() =>
      asUser(db, user, async (tx) => {
        const result = await tx.query(sql, params);
        if (oneObject && (reading || wantsRows) && result.rows.length !== 1) {
          // Thrown inside the transaction, so a change is undone, like the API does
          throw new Refusal(406, 'PGRST116', 'Cannot coerce the result to a single JSON object',
            `The result contains ${result.rows.length} rows`);
        }
        if (!wantsCount || !reading) return { rows: result.rows, total: null };
        const counted = await tx.query(
          `SELECT count(*)::int AS n FROM ${target}${whereSql}`,
          params,
        );
        return { rows: result.rows, total: counted.rows[0].n };
      }),
    ));
  } catch (error) {
    if (error instanceof Refusal || typeof error.code !== 'string') throw error;
    throw new Refusal(statusFor(error.code, user !== null), error.code, error.message,
      error.detail ?? null, error.hint ?? null);
  }

  const start = Number(url.searchParams.get('offset') ?? 0);
  const range = rows.length ? `${start}-${start + rows.length - 1}` : '*';
  const headers = { 'Content-Range': `${range}/${total ?? '*'}` };
  if (method === 'HEAD') return send(res, 200, undefined, headers);
  if (method === 'GET') return send(res, 200, oneObject ? rows[0] : rows, headers);
  const status = method === 'POST' ? 201 : wantsRows ? 200 : 204;
  if (!wantsRows) return send(res, status, undefined, headers);
  return send(res, status, oneObject ? rows[0] : rows, headers);
}

/**
 * Calls a function in public, like supabase.rpc(name, args) does. The stand-in only takes what
 * supabase.rpc() sends by default: a POST with the arguments by name in a JSON object. It sends
 * back the one value the function gives, so it doesn't do functions that give back rows.
 */
async function rpc(req, res, url, body, user, { db, functions, oneAtATime }) {
  if (req.method !== 'POST') {
    throw new Refusal(405, 'PGRST117', `Unsupported HTTP method: ${req.method}`);
  }
  const args = body ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Refusal(400, 'PGRST102', 'The body has to be a JSON object');
  }
  const name = url.pathname.slice('/rest/v1/rpc/'.length);
  const known = IDENT.test(name) ? functions.get(name) : undefined;
  const names = Object.keys(args);
  // Only names the function really has get into the SQL
  if (!known || !names.every((arg) => known.has(arg))) {
    throw new Refusal(404, 'PGRST202',
      `Could not find the function public.${name}(${names.join(', ')}) in the schema cache`);
  }
  const list = names.map((arg, i) => `"${arg}" => $${i + 1}::${known.get(arg)}`).join(', ');
  const params = names.map((arg) =>
    args[arg] !== null && typeof args[arg] === 'object' ? JSON.stringify(args[arg]) : args[arg]);

  let rows;
  try {
    ({ rows } = await oneAtATime(() =>
      asUser(db, user, (tx) => tx.query(`SELECT public."${name}"(${list}) AS value`, params)),
    ));
  } catch (error) {
    if (typeof error.code !== 'string') throw error;
    throw new Refusal(statusFor(error.code, user !== null), error.code, error.message,
      error.detail ?? null, error.hint ?? null);
  }
  return send(res, 200, rows[0].value);
}

// ----- Storage -----

// The biggest file any bucket takes (10 MB, from 005 and 006)
const FILE_LIMIT = 10 * 1024 * 1024;
const BUCKET = /^[a-z0-9-]+$/;
// Folders and a file name made of plain characters. No empty folders, and no . or .. folders
const FILE_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
// Parts of the Storage API under /object/ that aren't buckets
const NOT_BUCKETS = new Set(['authenticated', 'copy', 'info', 'list', 'move', 'public', 'sign']);
const NO_FILE = 'Either the object does not exist or you do not have access to it';

/** An error the Storage API sends back. */
function storageError(res, status, error, message) {
  return send(res, status, { statusCode: String(status), error, message });
}

/** Reads a file. Gives back null if it's over the biggest file a bucket takes. */
async function readFile(req) {
  const chunks = [];
  let size = 0;
  // Reads to the end even when it's too big, so the answer still gets back on the same connection
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= FILE_LIMIT) chunks.push(chunk);
  }
  return size > FILE_LIMIT ? null : Buffer.concat(chunks);
}

async function skipBody(req) {
  for await (const chunk of req) void chunk;
}

/** Splits <bucket>/<path> into the bucket and the path, or gives back null. */
function bucketAndPath(rest) {
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  if (!BUCKET.test(bucket) || NOT_BUCKETS.has(bucket)) return null;
  if (path && (path.length > 500 || !FILE_PATH.test(path))) return null;
  return { bucket, path };
}

async function bucketNamed(id, { db, oneAtATime }) {
  const { rows } = await oneAtATime(() =>
    db.query(
      'SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = $1',
      [id],
    ),
  );
  return rows[0] ?? null;
}

// A signed link is the file, the time it runs out and a signature over both. Supabase uses a JWT,
// but the website never reads the token, it only puts the link in an <img>.
function linkSignature(secret, file, expires) {
  return createHmac('sha256', secret).update(`${file}\n${expires}`).digest('base64url');
}

function signedToken(secret, file, seconds) {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  return `${expires}.${linkSignature(secret, file, expires)}`;
}

/** Why a signed link doesn't work, or null when it does. */
function badToken(secret, file, token) {
  const [expires, signature = ''] = String(token ?? '').split('.');
  const wanted = Buffer.from(linkSignature(secret, file, expires));
  const given = Buffer.from(signature);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return 'invalid signature';
  if (Number(expires) * 1000 <= Date.now()) return '"exp" claim timestamp check failed';
  return null;
}

/**
 * GET /storage/v1/object/public/<bucket>/<path>, a file in a public bucket, and
 * GET /storage/v1/object/sign/<bucket>/<path>?token=..., a signed link to a file in any bucket.
 * Neither needs the anon key or a sign in.
 */
async function openFile(req, res, url, kind, ctx) {
  await skipBody(req);
  const notFound = () => storageError(res, 404, 'not_found', 'Object not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
  const where = bucketAndPath(url.pathname.slice(`/storage/v1/object/${kind}/`.length));
  if (!where?.path) return notFound();
  const file = `${where.bucket}/${where.path}`;
  if (kind === 'sign') {
    const bad = badToken(ctx.linkSecret, file, url.searchParams.get('token'));
    if (bad) return storageError(res, 400, 'InvalidJWT', bad);
  }
  const bucket = await bucketNamed(where.bucket, ctx);
  const stored = ctx.files.get(file);
  // A file only shows while its row is in storage.objects, the same as on Supabase
  const { rows } = await ctx.oneAtATime(() =>
    ctx.db.query('SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2', [
      where.bucket,
      where.path,
    ]),
  );
  if (!bucket || (kind === 'public' && !bucket.public) || !stored || !rows.length) {
    return notFound();
  }
  res.writeHead(200, {
    'Content-Type': stored.type,
    'Content-Length': stored.bytes.length,
    'Cache-Control': 'no-cache',
  });
  return res.end(req.method === 'HEAD' ? undefined : stored.bytes);
}

/** Which part of Storage a request is for, out of the ones the website uses. */
function storageRoute(req, url) {
  if (!url.pathname.startsWith('/storage/v1/object/')) return null;
  const rest = url.pathname.slice('/storage/v1/object/'.length);
  const [action, where] =
    req.method === 'POST' && rest.startsWith('list/')
      ? ['list', bucketAndPath(rest.slice('list/'.length))]
      : req.method === 'POST' && rest.startsWith('sign/')
        ? ['sign', bucketAndPath(rest.slice('sign/'.length))]
        : req.method === 'POST'
          ? ['upload', bucketAndPath(rest)]
          : req.method === 'DELETE'
            ? ['remove', bucketAndPath(rest)]
            : [null, null];
  // Only uploads name a file. The others name a bucket and send the paths in the body
  if (!where || Boolean(where.path) !== (action === 'upload')) return null;
  return { action, ...where };
}

/**
 * The parts of Storage that the website uses, all run as whoever is asking, so the Storage
 * policies from 005, 006 and 009 decide what they can do: upload(path, bytes) to add a file,
 * remove(paths) to delete files, list(folder) to see what's in a folder and
 * createSignedUrls(paths, seconds) for links to private files.
 */
async function storage(req, res, url, ctx) {
  const route = storageRoute(req, url);
  if (!route) {
    await skipBody(req);
    return storageError(res, 404, 'not_found', 'The stand-in doesn’t have that part of Storage');
  }
  const bytes = route.action === 'upload' ? await readFile(req) : null;
  const { body, status, message } = route.action === 'upload' ? {} : await readBody(req);

  const user = whoIsAsking(req, ctx.auth);
  const bucket = await bucketNamed(route.bucket, ctx);
  if (!bucket) return storageError(res, 404, 'Bucket not found', 'Bucket not found');
  if (status) return storageError(res, status, 'invalid_request', message);

  const asker = (sql, params) =>
    ctx.oneAtATime(() => asUser(ctx.db, user, (tx) => tx.query(sql, params)));
  if (route.action === 'upload') return uploadFile(req, res, route, bucket, bytes, user, ctx);
  if (route.action === 'list') return listFolder(res, route, body, asker, ctx);
  if (route.action === 'sign') return signLinks(res, route, body, asker, ctx);
  return removeFiles(res, route, body, asker, ctx);
}

async function uploadFile(req, res, { bucket: bucketId, path }, bucket, bytes, user, ctx) {
  if (String(req.headers['x-upsert']) === 'true') {
    return storageError(res, 400, 'invalid_request', 'The stand-in can’t replace files');
  }
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    return storageError(res, 400, 'invalid_request', 'The stand-in only takes the file itself');
  }
  const limit = Number(bucket.file_size_limit ?? FILE_LIMIT);
  if (bytes === null || bytes.length > limit) {
    const tooBig = 'The object exceeded the maximum allowed size';
    return storageError(res, 413, 'Payload too large', tooBig);
  }
  if (bucket.allowed_mime_types && !bucket.allowed_mime_types.includes(type)) {
    return storageError(res, 415, 'invalid_mime_type', `mime type ${type} is not supported`);
  }

  try {
    await ctx.oneAtATime(() =>
      asUser(ctx.db, user, (tx) =>
        tx.query('INSERT INTO storage.objects (bucket_id, name, owner) VALUES ($1, $2, $3)', [
          bucketId,
          path,
          user?.id ?? null,
        ]),
      ),
    );
  } catch (error) {
    if (error.code === '23505') {
      return storageError(res, 409, 'Duplicate', 'The resource already exists');
    }
    if (error.code === '42501') {
      return storageError(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    }
    throw error;
  }
  ctx.files.set(`${bucketId}/${path}`, { bytes, type });
  return send(res, 200, { Id: randomUUID(), Key: `${bucketId}/${path}` });
}

function listOfPaths(value) {
  return Array.isArray(value) && value.length > 0 && value.every((p) => typeof p === 'string');
}

async function removeFiles(res, { bucket }, body, asker, ctx) {
  if (!listOfPaths(body?.prefixes)) {
    return storageError(res, 400, 'invalid_request', 'prefixes has to be a list of paths');
  }
  const { rows } = await asker(
    `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2)
     RETURNING id, bucket_id, name, owner, created_at`,
    [bucket, body.prefixes],
  );
  // Rows the policies don't let this user delete are skipped, so they keep their files
  for (const row of rows) ctx.files.delete(`${bucket}/${row.name}`);
  return send(res, 200, rows);
}

/** The files and folders straight inside a folder, like Supabase's list(). */
async function listFolder(res, { bucket }, body, asker, ctx) {
  const prefix = typeof body?.prefix === 'string' ? body.prefix.replace(/\/+$/, '') : '';
  const limit = Number.isInteger(body?.limit) && body.limit > 0 ? body.limit : 100;
  const offset = Number.isInteger(body?.offset) && body.offset > 0 ? body.offset : 0;
  const start = prefix ? `${prefix}/` : '';
  // Only the files this user can see, because the policies decide that too
  const { rows } = await asker(
    `SELECT id, name, created_at FROM storage.objects
     WHERE bucket_id = $1 AND left(name, length($2)) = $2`,
    [bucket, start],
  );
  const entries = new Map();
  for (const row of rows) {
    const name = row.name.slice(start.length);
    const slash = name.indexOf('/');
    if (slash === -1) {
      const file = ctx.files.get(`${bucket}/${row.name}`);
      const time = new Date(row.created_at).toISOString();
      entries.set(name, {
        name,
        id: row.id,
        updated_at: time,
        created_at: time,
        last_accessed_at: time,
        metadata: { size: file?.bytes.length ?? 0, mimetype: file?.type ?? null },
      });
    } else {
      const folder = name.slice(0, slash);
      const empty = { id: null, updated_at: null, created_at: null, last_accessed_at: null };
      if (!entries.has(folder)) entries.set(folder, { name: folder, ...empty, metadata: null });
    }
  }
  const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  if (body?.sortBy?.order === 'desc') sorted.reverse();
  return send(res, 200, sorted.slice(offset, offset + limit));
}

/** Links to files that work for a while without signing in, like createSignedUrls(). */
async function signLinks(res, { bucket }, body, asker, ctx) {
  if (!listOfPaths(body?.paths)) {
    return storageError(res, 400, 'invalid_request', 'paths has to be a list of paths');
  }
  if (!Number.isInteger(body.expiresIn) || body.expiresIn < 1) {
    return storageError(res, 400, 'invalid_request', 'expiresIn has to be a number of seconds');
  }
  // Only files this user can see get a link
  const { rows } = await asker(
    'SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2)',
    [bucket, body.paths],
  );
  const seen = new Set(rows.map((row) => row.name));
  return send(
    res,
    200,
    body.paths.map((path) => {
      if (!seen.has(path)) return { error: NO_FILE, path, signedURL: null };
      const token = signedToken(ctx.linkSecret, `${bucket}/${path}`, body.expiresIn);
      return { error: null, path, signedURL: `/object/sign/${bucket}/${path}?token=${token}` };
    }),
  );
}

// `npm run stand-in` runs this. STAND_IN_PORT changes the port, STAND_IN_TOKEN_SECONDS makes a
// sign in run out sooner, to try refreshing, STAND_IN_MAX_ROWS sends fewer rows per read, to try
// reading a long list in pages, STAND_IN_SQL_THROUGH=015 leaves out the SQL files after 015, and
// STAND_IN_SENSOR_DATA=0 starts with no sensor readings.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STAND_IN_PORT || 54321);
  const tokenSeconds = Number(process.env.STAND_IN_TOKEN_SECONDS || 3600);
  const maxRows = Number(process.env.STAND_IN_MAX_ROWS || 1000);
  const portWorks = Number.isInteger(port) && port >= 0 && port <= 65535;
  const maxRowsWorks = Number.isInteger(maxRows) && maxRows > 0;
  if (!portWorks || !Number.isInteger(tokenSeconds) || tokenSeconds < 0 || !maxRowsWorks) {
    console.error(
      'STAND_IN_PORT, STAND_IN_TOKEN_SECONDS and STAND_IN_MAX_ROWS have to be whole numbers.',
    );
    process.exit(1);
  }
  const sqlThrough = process.env.STAND_IN_SQL_THROUGH || null;
  const sensorData = process.env.STAND_IN_SENSOR_DATA !== '0';
  const standIn = await startStandIn({ port, tokenSeconds, maxRows, sqlThrough, sensorData });
  console.log(`Supabase stand-in running on ${standIn.url}, with the anon key ${ANON_KEY}`);
  console.log('Test accounts (the password is TEST_PASSWORD in stand-in.js):');
  for (const user of TEST_USERS) console.log(`  ${user.email}  ${user.role ?? 'no profile'}`);
  if (standIn.edgeCom) {
    console.log(`An edge on this computer uploads to ${standIn.url}/functions/v1/edge-com`);
    console.log(`  as ${TEST_DEVICE_ID}, with TEST_DEVICE_TOKEN in stand-in.js as its edge_key`);
  }
  console.log('Press Ctrl+C to stop it. Everything in it goes when it stops.');
}
