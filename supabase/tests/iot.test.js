// Checks the sensor files, 016_1 to 017 and 023 to 025, and our edge-com function, which is the
// only way readings get in: device tokens, what edge-com stores and leaves out, the alert rules
// with each node's own settings, nodes going quiet, acknowledging and resolving, commands for the
// nodes, calibration, who can read and change what, and that nothing from a node reaches the
// public. edge-com runs here in Node on the same database (edge-com.js). The last parts do it all
// through the stand-in, the way an edge device and the website do it. iot-limit.test.js checks 022.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { after, before, beforeEach, describe, test } from 'node:test';
import { EDGE_COM_RUNS, startEdgeCom } from './edge-com.js';
import { addUser, asUser, insertAs, newDatabase, readSql, selectAs, SQL_FILES } from './harness.js';
import { ANON_KEY, startStandIn, TEST_DEVICE_ID, TEST_PASSWORD, TEST_USERS } from './stand-in.js';

/** The sensor files, in the order they run. */
const IOT_FILES = SQL_FILES.filter((file) => file.includes('_iot_'));

let db;
let edge;
let botanist;
let researcher;
let visitor;
let officer;
let admin;
let keyA;
let keyB;
let nodeCount = 0;

const notAllowed = { code: '42501', message: /permission denied/ };
const notTheirRole = { code: '42501', message: /row-level security/ };
// What edge-com says to a wrong token, an unknown device and a device that's turned off
const notThisDevice = { status: 401, body: { error: "this device can't send readings" } };

// A reading where nothing is wrong: 55 % soil, no rain, the ground where it was
const CALM = {
  temp_c: 26,
  hum_pct: 80,
  soil_raw: 2600,
  rain_raw: 4095,
  dist_cm: 120,
  baseline_cm: 120,
  beep_on: 0,
  rssi: -60,
  motion: 0,
};
// The order of the values in a row, after seq, ts and lag (ROW_FIELDS in edge-com and cloud-com.py)
const VALUES = Object.keys(CALM);

function who(user) {
  return user ? user.role : 'anon';
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Each test's "now", in whole seconds, so a test that crosses into the next second still agrees
// with itself about when "60 seconds ago" was
let testNow;
beforeEach(() => {
  testNow = nowSeconds();
});

/** Calls a function as a user, the way the API does an RPC. It gives back the one value. */
async function call(user, sql, params = []) {
  const { rows } = await asUser(db, user, (tx) => tx.query(`SELECT ${sql} AS value`, params));
  return rows[0].value;
}

function makeToken(user, device) {
  return call(user, 'public.iot_make_device_token($1)', [device]);
}

/** Sends a batch to edge-com the way an edge does, and gives back the status and the answer. */
async function upload(key, batch, options) {
  const response = await edge.upload(key, batch, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// The next seq for each node and power-up, from 1 like the sketch
const seqs = new Map();

/**
 * Readings from one node in one upload. Each one is { ago, ...changes }: how many seconds ago it
 * was measured and what's different from CALM. seq carries on from the node's last reading.
 */
function send(node, readings, { device = 'REGION-A', key = keyA, boot = 1, lag = 1, batch = {} } = {}) {
  const now = testNow;
  const rows = readings.map(({ ago = 0, ...changes }) => {
    const id = `${node}/${boot}`;
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const values = { ...CALM, ...changes };
    return [seq, now - ago, lag, ...VALUES.map((name) => values[name])];
  });
  // The edge says which calibration it has. A big number means it has them all, so the answer
  // only has something in it when the test is about that
  return upload(key, {
    edge_id: device,
    nodes: [{ node_id: node, boot_id: boot, rows }],
    cal_since: Number.MAX_SAFE_INTEGER,
    ...batch,
  });
}

/** A new node on the device given, with its own settings, so each test has its own alerts. */
async function newNode({ device = 'REGION-A', settings = {} } = {}) {
  nodeCount += 1;
  // An underscore, like the sketch's default NNP_NODE_01, is fine in a node ID
  const id = `TEST_NODE-${nodeCount}`;
  await db.query(
    'INSERT INTO public.iot_nodes (node_id, name, zone, edge_device_id) VALUES ($1, $2, $3, $4)',
    [id, `Test node ${nodeCount}`, 'Test zone', device],
  );
  const columns = Object.keys(settings);
  if (columns.length) {
    // All in one change, because some settings have to agree with each other
    const set = columns.map((column, i) => `"${column}" = $${i + 2}`).join(', ');
    await db.query(`UPDATE public.iot_nodes SET ${set} WHERE node_id = $1`, [id, ...Object.values(settings)]);
  }
  return id;
}

/** Reads straight from the table as the postgres user, so no rules get in the way. */
async function storedReadings(node) {
  const { rows } = await db.query(
    'SELECT * FROM public.iot_readings WHERE node_id = $1 ORDER BY recorded_at, seq',
    [node],
  );
  return rows;
}

async function alertsFor(node, type) {
  const { rows } = await db.query(
    `SELECT * FROM public.iot_alerts WHERE node_id = $1 AND ($2::text IS NULL OR type = $2)
     ORDER BY id`,
    [node, type ?? null],
  );
  return rows;
}

async function nodeRow(node) {
  const { rows } = await db.query('SELECT * FROM public.iot_nodes WHERE node_id = $1', [node]);
  return rows[0];
}

async function statusOf(node) {
  return (await nodeRow(node)).status;
}

/** The lowest raw value that a node with the default calibration reads as pct percent. */
async function rawFor(pct, { dry = 4095, wet = 1400 } = {}) {
  const { rows } = await db.query(
    `SELECT min(raw) AS raw FROM generate_series(0, 4095) AS raw
     WHERE public.iot_raw_pct(raw, $2, $3) = $1`,
    [pct, dry, wet],
  );
  assert.notEqual(rows[0].raw, null, `no raw value reads as ${pct} %`);
  return rows[0].raw;
}

const soilAt = (pct) => rawFor(pct);
const rainAt = (pct) => rawFor(pct, { dry: 4095, wet: 1500 });

before(async () => {
  assert.ok(EDGE_COM_RUNS, 'These tests run edge-com, which needs Node 22.13 or newer');
  db = await newDatabase();
  edge = await startEdgeCom(db, { output: { log() {}, warn() {}, error: console.error } });
  botanist = await addUser(db, { role: 'botanist', name: 'Field botanist' });
  researcher = await addUser(db, { role: 'researcher', name: 'Researcher' });
  visitor = await addUser(db, { name: 'Visitor' });
  officer = await addUser(db, { role: 'conservation_officer', name: 'Park officer' });
  admin = await addUser(db, { role: 'admin', name: 'Park admin' });

  await insertAs(db, admin, 'public.iot_devices', { device_id: 'REGION-A', name: 'Region A' });
  await insertAs(db, admin, 'public.iot_devices', { device_id: 'REGION-B', name: 'Region B' });
  keyA = (await makeToken(admin, 'REGION-A')).token;
  keyB = (await makeToken(admin, 'REGION-B')).token;
});

after(async () => {
  await edge.close();
  await db.close();
});

describe('device tokens', () => {
  test('only admins can make one', async () => {
    for (const user of [visitor, researcher, botanist, officer]) {
      await assert.rejects(makeToken(user, 'REGION-A'), { code: '42501' }, who(user));
    }
    await assert.rejects(makeToken(null, 'REGION-A'), notAllowed);
  });

  test('the plain token is handed back once and only its hash is kept', async () => {
    await insertAs(db, admin, 'public.iot_devices', { device_id: 'HASH-TEST', name: 'Hash test' });
    const made = await makeToken(admin, 'HASH-TEST');
    assert.deepEqual(Object.keys(made).sort(), ['device_id', 'token', 'token_made_at']);
    assert.match(made.token, /^niah_device_[0-9a-f]{64}$/);

    const { rows } = await db.query(
      "SELECT encode(token_hash, 'hex') AS hash FROM public.iot_device_tokens WHERE device_id = $1",
      ['HASH-TEST'],
    );
    const hash = createHash('sha256').update(made.token).digest('hex');
    assert.deepEqual(rows, [{ hash }]);

    // Nothing else in the row has it
    const { rows: device } = await db.query('SELECT * FROM public.iot_devices WHERE device_id = $1', [
      'HASH-TEST',
    ]);
    assert.ok(!JSON.stringify(device).includes(made.token));
    await assert.rejects(makeToken(admin, 'NO-SUCH-DEVICE'), /no device/);
  });

  test('two tokens are never the same', async () => {
    const first = await makeToken(admin, 'HASH-TEST');
    const second = await makeToken(admin, 'HASH-TEST');
    assert.notEqual(first.token, second.token);
  });

  test('a new token stops the old one straight away', async () => {
    await insertAs(db, admin, 'public.iot_devices', { device_id: 'ROTATE', name: 'Rotate test' });
    const old = await makeToken(admin, 'ROTATE');
    assert.equal((await upload(old.token, { edge_id: 'ROTATE' })).status, 204);

    const replaced = await makeToken(admin, 'ROTATE');
    assert.deepEqual(await upload(old.token, { edge_id: 'ROTATE' }), notThisDevice);
    assert.equal((await upload(replaced.token, { edge_id: 'ROTATE' })).status, 204);
  });

  test('the device says who made the token and when, and nobody can write that themselves', async () => {
    const startedAt = new Date();
    await makeToken(admin, 'ROTATE');
    const [device] = await selectAs(
      db,
      admin,
      'SELECT token_made_at, token_made_by_name FROM public.iot_devices WHERE device_id = $1',
      ['ROTATE'],
    );
    assert.equal(device.token_made_by_name, 'Park admin');
    assert.ok(device.token_made_at >= new Date(startedAt.getTime() - 1000));

    for (const column of ['token_made_by_name', 'token_made_at', 'last_heard_at', 'created_at']) {
      const forged = `UPDATE public.iot_devices SET ${column} = NULL WHERE device_id = $1`;
      await assert.rejects(selectAs(db, admin, forged, ['ROTATE']), notAllowed, column);
    }
  });

  test('nobody reads or writes the hashes through the API, admins included', async () => {
    for (const user of [null, visitor, researcher, botanist, officer, admin]) {
      await assert.rejects(
        selectAs(db, user, 'SELECT * FROM public.iot_device_tokens'),
        notAllowed,
        who(user),
      );
      await assert.rejects(
        selectAs(db, user, "DELETE FROM public.iot_device_tokens WHERE device_id = 'REGION-A'"),
        notAllowed,
        who(user),
      );
    }
    const { rows } = await db.query(
      `SELECT
         has_table_privilege('service_role', 'public.iot_device_tokens', 'SELECT') AS service_reads,
         relrowsecurity
       FROM pg_class WHERE oid = 'public.iot_device_tokens'::regclass`,
    );
    assert.deepEqual(rows, [{ service_reads: false, relrowsecurity: true }]);
  });
});

describe('who edge-com takes uploads from', () => {
  test('a wrong token, an unknown device and a device turned off all get the same answer', async () => {
    await insertAs(db, admin, 'public.iot_devices', { device_id: 'TURNED-OFF', name: 'Off' });
    await insertAs(db, admin, 'public.iot_devices', { device_id: 'NO-TOKEN', name: 'No token' });
    const offKey = (await makeToken(admin, 'TURNED-OFF')).token;
    await selectAs(db, admin, 'UPDATE public.iot_devices SET enabled = false WHERE device_id = $1', [
      'TURNED-OFF',
    ]);

    for (const [device, key] of [
      ['REGION-A', 'wrong-but-long-enough'],
      ['REGION-A', keyB],
      ['NO-SUCH-DEVICE', keyA],
      ['NO-TOKEN', keyA],
      ['TURNED-OFF', offKey],
    ]) {
      assert.deepEqual(await upload(key, { edge_id: device }), notThisDevice, `${device}`);
    }
    // A key or device ID that can't be one is turned down before the database is asked
    for (const [device, key] of [
      ['REGION-A', ''],
      ['REGION-A', 'short'],
      ['REGION-A', 'x'.repeat(201)],
      [null, keyA],
      ['has space', keyA],
    ]) {
      assert.equal((await upload(key, { edge_id: device })).status, 401, `${device} ${key}`);
    }

    // Turning it back on lets it send again, with the same token
    await selectAs(db, admin, 'UPDATE public.iot_devices SET enabled = true WHERE device_id = $1', [
      'TURNED-OFF',
    ]);
    assert.equal((await upload(offKey, { edge_id: 'TURNED-OFF' })).status, 204);
  });

  test('only a POST of JSON, plain or gzipped, of a size it takes', async () => {
    const asked = (init) => edge.handle(new Request('http://edge-com.test/', init));
    assert.equal((await asked({ method: 'GET' })).status, 405);
    const notJson = await asked({ method: 'POST', body: '{nope', headers: { 'x-edge-key': keyA } });
    assert.equal(notJson.status, 400);
    const list = await asked({ method: 'POST', body: '[]', headers: { 'x-edge-key': keyA } });
    assert.equal(list.status, 400);
    const plain = await upload(keyA, { edge_id: 'REGION-A' }, { gzip: false });
    assert.equal(plain.status, 204);

    const node = await newNode();
    const rows = Array.from({ length: 1001 }, (_, i) => [i + 1, nowSeconds(), 1, ...VALUES.map((v) => CALM[v])]);
    const tooMany = await upload(keyA, { edge_id: 'REGION-A', nodes: [{ node_id: node, boot_id: 1, rows }] });
    assert.equal(tooMany.status, 413);
    assert.deepEqual(await storedReadings(node), []);
    // Over 4 MB once it's unzipped
    const huge = gzipSync(JSON.stringify({ edge_id: 'REGION-A', padding: 'x'.repeat(5_000_000) }));
    const big = await asked({ method: 'POST', body: huge, headers: { 'x-edge-key': keyA } });
    assert.equal(big.status, 413);
  });

  test('an upload says the device is alive, even an empty one', async () => {
    const startedAt = new Date();
    assert.equal((await upload(keyB, { edge_id: 'REGION-B' })).status, 204);
    const [device] = await selectAs(
      db,
      officer,
      'SELECT last_heard_at FROM public.iot_devices WHERE device_id = $1',
      ['REGION-B'],
    );
    assert.ok(device.last_heard_at >= new Date(startedAt.getTime() - 1000));
  });
});

describe('the readings edge-com stores', () => {
  test('it stores the raw values, the device, the power-up and both times', async () => {
    const node = await newNode();
    const measured = nowSeconds() - 30;
    const sent = [1, measured, 4, 25.5, 71, 2222, 3999, 118.4, 120, 1, -67, 1];
    const answer = await upload(keyA, {
      edge_id: 'REGION-A',
      nodes: [{ node_id: node, boot_id: 2840193877, rows: [sent] }],
      cal_since: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(answer.status, 204);

    const [stored] = await storedReadings(node);
    assert.equal(stored.device_id, 'REGION-A');
    assert.equal(Number(stored.boot_id), 2840193877);
    assert.equal(Number(stored.seq), 1);
    assert.equal(stored.recorded_at.getTime(), measured * 1000);
    // The node measured it, and the edge got it 4 seconds later
    assert.equal(stored.ts_source, 'device');
    assert.equal(stored.received_at.getTime(), (measured + 4) * 1000);
    assert.deepEqual(
      VALUES.map((name) => stored[name]),
      [25.5, 71, 2222, 3999, 118.4, 120, true, -67, true],
    );
  });

  test('with no lag, the time is the edge’s, because the node had no clock yet', async () => {
    const node = await newNode();
    await send(node, [{ ago: 5 }], { lag: null });
    const [stored] = await storedReadings(node);
    assert.equal(stored.ts_source, 'edge');
    assert.equal(stored.received_at.getTime(), stored.recorded_at.getTime());
  });

  test('a value no part could measure is left out, and the rest of the reading is kept', async () => {
    const node = await newNode();
    const tooFar = {
      temp_c: 51,
      hum_pct: -1,
      soil_raw: 4096,
      rain_raw: 1.5,
      dist_cm: 1001,
      baseline_cm: 'far',
      beep_on: 2,
      rssi: 1,
      motion: true,
    };
    for (const [name, value] of Object.entries(tooFar)) {
      await send(node, [{ ago: 10, [name]: value }]);
    }
    const stored = await storedReadings(node);
    assert.equal(stored.length, VALUES.length);
    stored.forEach((reading, i) => {
      const leftOut = VALUES[i];
      assert.equal(reading[leftOut], null, leftOut);
      // Another value from the same reading is still there
      const other = VALUES[(i + 1) % VALUES.length];
      assert.notEqual(reading[other], null, `${leftOut} took ${other} with it`);
    });

    // The edges of each range are fine
    const edges = { temp_c: 50, hum_pct: 0, soil_raw: 0, rain_raw: 4095, dist_cm: 0, rssi: -127 };
    await send(node, [{ ago: 5, ...edges }]);
    const last = (await storedReadings(node)).at(-1);
    for (const [name, value] of Object.entries(edges)) assert.equal(last[name], value, name);
  });

  test('the database checks the ranges too, and says which value was wrong', async () => {
    const node = await newNode();
    const insert = (column, value) =>
      db.query(
        `INSERT INTO public.iot_readings (device_id, node_id, boot_id, seq, recorded_at, ts_source,
           received_at, "${column}")
         VALUES ('REGION-A', $1, 1, 999, now(), 'device', now(), $2)`,
        [node, value],
      );
    for (const [column, value] of [
      ['temp_c', 50.5],
      ['hum_pct', 101],
      ['soil_raw', 5000],
      ['rain_raw', -1],
      ['dist_cm', 1001],
      ['baseline_cm', -1],
      ['rssi', 1],
    ]) {
      await assert.rejects(insert(column, value), new RegExp(`${column}_in_range`), column);
    }
    await assert.rejects(
      db.query(
        `INSERT INTO public.iot_readings (device_id, node_id, boot_id, seq, recorded_at, ts_source,
           received_at) VALUES ('REGION-A', $1, 1, 1, now(), 'gps', now())`,
        [node],
      ),
      /ts_source_kind/,
    );
  });

  test('a reading measured more than 5 minutes ahead is skipped, and old ones are kept', async () => {
    const node = await newNode();
    await send(node, [{ ago: -6 * 60 }, { ago: -4 * 60 }, { ago: 2 * 24 * 3600 }]);
    const stored = await storedReadings(node);
    assert.deepEqual(
      stored.map((reading) => Math.round((reading.recorded_at.getTime() / 1000 - testNow) / 60)),
      [-2 * 24 * 60, 4],
    );
  });

  test('a reading that is not a row of 12 values is skipped on its own', async () => {
    const node = await newNode();
    const good = [1, nowSeconds(), 1, ...VALUES.map((v) => CALM[v])];
    const answer = await upload(keyA, {
      edge_id: 'REGION-A',
      nodes: [
        {
          node_id: node,
          boot_id: 3,
          rows: [good, [2, nowSeconds()], 'x', [null, nowSeconds(), 1, ...VALUES.map(() => null)], [3, 'now', 1, ...VALUES.map(() => null)]],
        },
      ],
      cal_since: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(answer.status, 204);
    assert.equal((await storedReadings(node)).length, 1);
  });

  test('sending a reading again stores it once, and a new power-up starts again from 1', async () => {
    const node = await newNode();
    const row = [1, nowSeconds() - 20, 1, ...VALUES.map((v) => CALM[v])];
    const batch = (boot) => ({
      edge_id: 'REGION-A',
      nodes: [{ node_id: node, boot_id: boot, rows: [row] }],
      cal_since: Number.MAX_SAFE_INTEGER,
    });
    await upload(keyA, batch(10));
    await upload(keyA, batch(10));
    assert.equal((await storedReadings(node)).length, 1);
    await upload(keyA, batch(11));
    assert.equal((await storedReadings(node)).length, 2);
  });

  test("a device can't add readings or positions for another device's node, or an unlinked one", async () => {
    const theirs = await newNode({ device: 'REGION-B' });
    const unlinked = await newNode({ device: null });
    const mine = await newNode();
    const row = [1, nowSeconds(), 1, ...VALUES.map((v) => CALM[v])];
    const answer = await upload(keyA, {
      edge_id: 'REGION-A',
      nodes: [theirs, unlinked, 'NO-SUCH-NODE', mine].map((node) => ({ node_id: node, boot_id: 1, rows: [row] })),
      boots: [theirs, mine].map((node) => ({
        node_id: node,
        boot_id: 1,
        lat: 3.81,
        lon: 113.78,
        at: new Date().toISOString(),
      })),
      cal_since: Number.MAX_SAFE_INTEGER,
    });
    // The rest of the batch still goes in, so one wrongly linked node doesn't hold up the others
    assert.equal(answer.status, 204);
    assert.deepEqual(await storedReadings(theirs), []);
    assert.deepEqual(await storedReadings(unlinked), []);
    assert.equal((await storedReadings(mine)).length, 1);
    const { rows } = await db.query('SELECT node_id FROM public.iot_boots WHERE node_id = ANY($1)', [
      [theirs, mine],
    ]);
    assert.deepEqual(rows, [{ node_id: mine }]);
  });

  test('the node keeps what its newest reading said, and an older batch does not change it', async () => {
    const node = await newNode();
    await send(node, [{ ago: 60, rssi: -70, beep_on: 1, baseline_cm: 118 }]);
    let row = await nodeRow(node);
    assert.deepEqual([row.last_rssi, row.beep_on, row.baseline_cm], [-70, true, 118]);
    const heartbeat = row.last_heartbeat.getTime();
    assert.equal(heartbeat, (testNow - 60) * 1000, 'last_heartbeat is the reading’s time');

    // Readings from the edge's buffer, measured before the one above
    await send(node, [{ ago: 300, rssi: -90, beep_on: 0, baseline_cm: 200 }]);
    row = await nodeRow(node);
    assert.deepEqual([row.last_rssi, row.beep_on, row.baseline_cm], [-70, true, 118]);
    assert.equal(row.last_heartbeat.getTime(), heartbeat);
  });

  test('each power-up keeps its position and the first and last reading that arrived', async () => {
    const node = await newNode();
    const at = new Date().toISOString();
    await send(node, [{ ago: 50 }, { ago: 40 }], {
      boot: 77,
      batch: { boots: [{ node_id: node, boot_id: 77, lat: 3.8151, lon: 113.7792, at }] },
    });
    // seq 3 went missing, then 4 and 5 came
    seqs.set(`${node}/77`, 3);
    await send(node, [{ ago: 20 }, { ago: 10 }], { boot: 77 });
    const { rows } = await db.query('SELECT * FROM public.iot_boots WHERE node_id = $1', [node]);
    assert.equal(rows.length, 1);
    const [boot] = rows;
    assert.deepEqual(
      [boot.device_id, boot.latitude, boot.longitude, Number(boot.first_seq), Number(boot.last_seq)],
      ['REGION-A', 3.8151, 113.7792, 1, 5],
    );
    assert.equal(boot.position_at.toISOString(), at);
    assert.equal(boot.first_recorded_at.getTime(), (testNow - 50) * 1000);

    // A position needs both halves, or it's kept as no position
    await upload(keyA, {
      edge_id: 'REGION-A',
      boots: [{ node_id: node, boot_id: 78, lat: 3.8, at }],
    });
    const { rows: half } = await db.query(
      'SELECT latitude, longitude FROM public.iot_boots WHERE node_id = $1 AND boot_id = 78',
      [node],
    );
    assert.deepEqual(half, [{ latitude: null, longitude: null }]);
  });
});

describe('working out percent from the raw values', () => {
  test('iot_raw_pct maps dry to 0 and wet to 100, whole numbers, kept within 0 to 100', async () => {
    const pct = (raw, dry, wet) => call(officer, 'public.iot_raw_pct($1, $2, $3)', [raw, dry, wet]);
    assert.equal(await pct(4095, 4095, 1400), 0);
    assert.equal(await pct(1400, 4095, 1400), 100);
    assert.equal(await pct(2600, 4095, 1400), 55);
    // Cut down to a whole number like the ESP32 and the edge do, not rounded
    assert.equal(await pct(1670, 4095, 1400), 89);
    assert.equal(await pct(4095 + 0, 4000, 1400), 0);
    assert.equal(await pct(1000, 4095, 1400), 100);
    // A sensor wired the other way round
    assert.equal(await pct(3000, 1000, 3000), 100);
    assert.equal(await pct(null, 4095, 1400), null);
    assert.equal(await pct(2000, 1400, 1400), null);
  });

  test('a new calibration changes what the old readings read as', async () => {
    const node = await newNode();
    await send(node, [{ ago: 30, soil_raw: 2600 }]);
    const soil = async () =>
      (await selectAs(db, officer, 'SELECT soil_pct FROM public.iot_node_status WHERE node_id = $1', [node]))[0]
        .soil_pct;
    assert.equal(await soil(), 55);
    await selectAs(db, admin, 'UPDATE public.iot_nodes SET soil_wet_raw = 2000 WHERE node_id = $1', [node]);
    assert.equal(await soil(), 71);
  });
});

describe('the alert rules', () => {
  const RULES = [
    // type, severity, what raises it, the closest that doesn't, the node's settings
    ['SATURATED', 'urgent', async () => ({ soil_raw: await soilAt(85) }), async () => ({ soil_raw: await soilAt(84) })],
    ['HEAVY', 'urgent', async () => ({ rain_raw: await rainAt(60) }), async () => ({ rain_raw: await rainAt(59) })],
    ['TOO_HOT', 'urgent', async () => ({ temp_c: 45 }), async () => ({ temp_c: 44.9 })],
    ['MOVED', 'urgent', async () => ({ dist_cm: 130.1 }), async () => ({ dist_cm: 130 })],
    ['NO_ECHO', 'urgent', async () => ({ dist_cm: null }), async () => ({ dist_cm: 0.5, baseline_cm: 0 })],
    ['MOTION', 'urgent', async () => ({ motion: 1 }), async () => ({ motion: 0 })],
    ['DRY', 'routine', async () => ({ soil_raw: await soilAt(20) }), async () => ({ soil_raw: await soilAt(21) }), true],
    ['RAIN', 'routine', async () => ({ rain_raw: await rainAt(20) }), async () => ({ rain_raw: await rainAt(19) }), true],
  ];

  for (const [type, severity, raises, doesNot, needsTurningOn] of RULES) {
    test(`${type} raises ${severity === 'urgent' ? 'an' : 'a'} ${severity} alert, and just short of it nothing`, async () => {
      const settings = needsTurningOn
        ? { alert_types: ['SATURATED', 'DRY', 'HEAVY', 'RAIN', 'MOVED', 'NO_ECHO', 'MOTION', 'TOO_HOT', 'QUIET'] }
        : {};
      const node = await newNode({ settings });
      await send(node, [{ ago: 120, ...(await doesNot()) }]);
      assert.deepEqual(await alertsFor(node), []);
      assert.equal(await statusOf(node), 'online');

      await send(node, [{ ago: 60, ...(await raises()) }]);
      const alerts = await alertsFor(node);
      assert.deepEqual(
        alerts.map((a) => [a.type, a.severity, a.status, a.from_backlog]),
        [[type, severity, 'open', false]],
      );
      assert.equal(alerts[0].node_name, (await nodeRow(node)).name);
      assert.equal(alerts[0].device_id, 'REGION-A');
      assert.equal(alerts[0].recorded_at.getTime(), (testNow - 60) * 1000);
      assert.equal(await statusOf(node), severity === 'urgent' ? 'threat_triggered' : 'warning');
    });
  }

  test('DRY and RAIN only raise alerts on a node that has them turned on', async () => {
    const node = await newNode();
    await send(node, [{ ago: 60, soil_raw: await soilAt(5), rain_raw: await rainAt(40) }]);
    assert.deepEqual(await alertsFor(node), []);
  });

  test('a type turned off raises nothing, and a value the node lacks raises nothing', async () => {
    const node = await newNode({ settings: { alert_types: ['SATURATED', 'QUIET'] } });
    await send(node, [{ ago: 90, motion: 1, temp_c: 49, dist_cm: null }]);
    await send(node, [{ ago: 60, soil_raw: null, baseline_cm: null }]);
    assert.deepEqual(await alertsFor(node), []);
  });

  test('a calm reading raises nothing', async () => {
    const node = await newNode();
    await send(node, [{ ago: 60 }]);
    assert.deepEqual(await alertsFor(node), []);
  });

  test('one problem that carries on is one alert, however many readings show it', async () => {
    const node = await newNode();
    const wet = await soilAt(95);
    await send(node, Array.from({ length: 20 }, (_, i) => ({ ago: 400 - i * 10, soil_raw: wet })));
    await send(node, [{ ago: 100, soil_raw: wet }]);
    const alerts = await alertsFor(node);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].recorded_at.getTime(), (testNow - 400) * 1000);
  });

  test('sending the same readings again does not count them twice', async () => {
    const node = await newNode({ settings: { alert_confirm_readings: 2 } });
    const row = [1, nowSeconds() - 60, 1, ...VALUES.map((v) => CALM[v])];
    row[3] = 47; // temp_c
    const batch = { edge_id: 'REGION-A', nodes: [{ node_id: node, boot_id: 1, rows: [row] }] };
    await upload(keyA, batch);
    await upload(keyA, batch);
    assert.deepEqual(await alertsFor(node), []);
  });

  test('different problems and different nodes get their own alerts', async () => {
    const first = await newNode();
    const second = await newNode();
    await send(first, [{ ago: 60, motion: 1, temp_c: 46 }]);
    await send(second, [{ ago: 60, motion: 1 }]);
    assert.deepEqual((await alertsFor(first)).map((a) => a.type).sort(), ['MOTION', 'TOO_HOT']);
    assert.deepEqual((await alertsFor(second)).map((a) => a.type), ['MOTION']);
  });

  test('an alert ends by itself only once a reading is back past the clear line', async () => {
    const node = await newNode();
    await send(node, [
      { ago: 400, soil_raw: await soilAt(86) },
      // Between the clear line (80) and the alert line (85): still going on
      { ago: 340, soil_raw: await soilAt(82) },
    ]);
    let [alert] = await alertsFor(node);
    assert.equal(alert.cleared_at, null);

    await send(node, [{ ago: 280, soil_raw: await soilAt(79) }]);
    [alert] = await alertsFor(node);
    assert.equal(alert.cleared_recorded_at.getTime(), (testNow - 280) * 1000);
    assert.notEqual(alert.cleared_at, null);
    // It ended, but nobody has resolved it, so it waits for someone on the Sensors page
    assert.equal(alert.status, 'open');
    assert.equal(await statusOf(node), 'online');
  });

  test('after an end, the same problem stays quiet for alert_rearm_s, by the readings’ clock', async () => {
    const node = await newNode();
    const wet = await soilAt(90);
    const dry = await soilAt(50);
    await send(node, [
      { ago: 1000, soil_raw: wet },
      { ago: 900, soil_raw: dry },
      // 100 seconds after it ended: under the default 300, so no new alert
      { ago: 800, soil_raw: wet },
      { ago: 750, soil_raw: dry },
      // 400 seconds after: a new one
      { ago: 500, soil_raw: wet },
    ]);
    const alerts = await alertsFor(node);
    assert.deepEqual(
      alerts.map((a) => (testNow * 1000 - a.recorded_at.getTime()) / 1000),
      [1000, 500],
    );
  });

  test('alert_confirm_readings in a row open one, from the first of them, and end one', async () => {
    const node = await newNode({ settings: { alert_confirm_readings: 3 } });
    await send(node, [
      { ago: 600, temp_c: 46 },
      { ago: 540, temp_c: 46 },
      { ago: 480 },
      { ago: 420, temp_c: 46 },
      { ago: 360, temp_c: 46 },
    ]);
    assert.deepEqual(await alertsFor(node), []);
    await send(node, [{ ago: 300, temp_c: 47 }]);
    let [alert] = await alertsFor(node);
    assert.equal(alert.recorded_at.getTime(), (testNow - 420) * 1000);
    assert.equal(alert.confirmed_recorded_at.getTime(), (testNow - 300) * 1000);
    assert.equal(Number(alert.seq), 4);

    await send(node, [{ ago: 240 }, { ago: 180 }]);
    assert.equal((await alertsFor(node))[0].cleared_at, null);
    await send(node, [{ ago: 120 }]);
    [alert] = await alertsFor(node);
    assert.equal(alert.cleared_recorded_at.getTime(), (testNow - 240) * 1000);
  });

  test('MOTION ends after motion_clear_readings readings in a row without movement', async () => {
    const node = await newNode();
    await send(node, [{ ago: 300, motion: 1 }, { ago: 240 }, { ago: 180, motion: 1 }, { ago: 120 }]);
    assert.equal((await alertsFor(node))[0].cleared_at, null);
    await send(node, [{ ago: 60 }]);
    const [alert] = await alertsFor(node);
    assert.equal(alert.cleared_recorded_at.getTime(), (testNow - 120) * 1000);
    // The second movement was during the same alert
    assert.equal((await alertsFor(node)).length, 1);
  });

  test('a reading older than one already judged does not change an alert', async () => {
    const node = await newNode();
    await send(node, [{ ago: 200, soil_raw: await soilAt(90) }]);
    await send(node, [{ ago: 400 }]);
    const [alert] = await alertsFor(node);
    assert.equal(alert.cleared_at, null);
  });

  test('an alert that started over an hour before it came in is from the backlog', async () => {
    const node = await newNode();
    await send(node, [{ ago: 2 * 3600, motion: 1 }, { ago: 2 * 3600 - 60 }, { ago: 2 * 3600 - 120 }]);
    const [alert] = await alertsFor(node, 'MOTION');
    // Kept with its real times, ended, and not something for anyone to rush to
    assert.equal(alert.from_backlog, true);
    assert.equal(alert.recorded_at.getTime(), (testNow - 2 * 3600) * 1000);
    assert.notEqual(alert.cleared_at, null);
  });

  test('the database only lets one alert start at one reading', async () => {
    const node = await newNode();
    await send(node, [{ ago: 60, motion: 1 }]);
    const [alert] = await alertsFor(node);
    await assert.rejects(
      db.query(
        `INSERT INTO public.iot_alerts (node_id, node_name, device_id, type, severity, boot_id, seq,
           recorded_at, confirmed_recorded_at)
         SELECT node_id, node_name, device_id, type, severity, boot_id, seq, recorded_at, recorded_at
         FROM public.iot_alerts WHERE id = $1`,
        [alert.id],
      ),
      /iot_alerts_one_per_start/,
    );
  });
});

describe('nodes going quiet', () => {
  const minutes = (n) => n * 60;
  const check = (user = officer) => call(user, 'public.iot_check_alerts()');

  test('no reading for longer than quiet_minutes makes one urgent alert, however often it is checked', async () => {
    const node = await newNode();
    await send(node, [{ ago: minutes(20) }]);
    await check();
    await check();
    const alerts = await alertsFor(node, 'QUIET');
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].severity, alerts[0].boot_id, alerts[0].seq], ['urgent', null, null]);
    assert.equal(alerts[0].recorded_at.getTime(), (testNow - minutes(20)) * 1000);
    assert.equal(await statusOf(node), 'offline');
  });

  test('under the limit nothing happens, and each node has its own limit', async () => {
    const node = await newNode();
    const patient = await newNode({ settings: { quiet_minutes: 60 } });
    await send(node, [{ ago: minutes(10) }]);
    await send(patient, [{ ago: minutes(30) }]);
    await check();
    assert.deepEqual(await alertsFor(node), []);
    assert.deepEqual(await alertsFor(patient), []);
  });

  test('a node without QUIET in its alert types never gets one', async () => {
    const node = await newNode({ settings: { alert_types: ['MOTION'] } });
    await send(node, [{ ago: minutes(40) }]);
    await check();
    assert.deepEqual(await alertsFor(node), []);
  });

  test('resolving it does not bring it back during the same silence', async () => {
    const node = await newNode();
    await send(node, [{ ago: minutes(20) }]);
    const [alert] = await alertsFor(node, 'QUIET');
    await call(officer, 'public.iot_resolve_alert($1)', [alert.id]);
    await check();
    assert.equal((await alertsFor(node, 'QUIET')).length, 1);
  });

  test('a new reading ends it by itself, and a later silence makes a new one', async () => {
    const node = await newNode();
    await send(node, [{ ago: minutes(20) }]);
    await send(node, [{ ago: 30 }]);
    let alerts = await alertsFor(node, 'QUIET');
    assert.equal(alerts[0].cleared_recorded_at.getTime(), (testNow - 30) * 1000);
    assert.equal(await statusOf(node), 'online');

    // As if 30 minutes went by
    await db.query(
      "UPDATE public.iot_readings SET recorded_at = recorded_at - interval '30 minutes' WHERE node_id = $1",
      [node],
    );
    await check();
    alerts = await alertsFor(node, 'QUIET');
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].cleared_at, null);
  });

  test('an old reading from a buffer does not end it, because the node may still be quiet', async () => {
    const node = await newNode();
    await send(node, [{ ago: minutes(30) }]);
    await send(node, [{ ago: minutes(20) }]);
    const [alert] = await alertsFor(node, 'QUIET');
    assert.equal(alert.cleared_at, null);
  });

  test('an upload from any device catches a node that has stopped on another', async () => {
    const node = await newNode({ device: 'REGION-B' });
    await db.query(
      `INSERT INTO public.iot_readings (device_id, node_id, boot_id, seq, recorded_at, ts_source, received_at)
       VALUES ('REGION-B', $1, 1, 1, now() - interval '40 minutes', 'device', now() - interval '40 minutes')`,
      [node],
    );
    assert.deepEqual(await alertsFor(node), []);
    await upload(keyA, { edge_id: 'REGION-A' });
    assert.equal((await alertsFor(node, 'QUIET')).length, 1);
  });

  test('a node that has never sent anything is not quiet, so the sample nodes stay silent', async () => {
    const node = await newNode();
    await check();
    assert.deepEqual(await alertsFor(node), []);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM public.iot_alerts WHERE node_id NOT LIKE 'TEST_NODE-%'",
    );
    assert.equal(rows[0].n, 0);
  });

  test('only officers and admins can check, and nobody can run the scan directly', async () => {
    for (const user of [null, visitor, researcher, botanist]) {
      await assert.rejects(check(user), { code: '42501' }, who(user));
    }
    assert.ok(await check(admin));
    for (const user of [null, officer, admin]) {
      await assert.rejects(call(user, 'public.iot_raise_quiet_alerts()'), notAllowed, who(user));
      await assert.rejects(
        call(user, "public.iot_refresh_node_status(ARRAY['x'])"),
        notAllowed,
        who(user),
      );
    }
  });
});

describe('the count for the staff menu', () => {
  const count = () => call(officer, 'public.iot_check_alerts()');
  const change = (before, after) => ({ urgent: after.urgent - before.urgent, open: after.open - before.open });

  test('it counts alerts going on that nobody has picked up, and urgent ones apart', async () => {
    const start = await count();
    const urgent = await newNode();
    await send(urgent, [{ ago: 60, motion: 1 }]);
    assert.deepEqual(change(start, await count()), { urgent: 1, open: 1 });

    const routine = await newNode({ settings: { alert_types: ['DRY', 'QUIET'] } });
    await send(routine, [{ ago: 60, soil_raw: await soilAt(10) }]);
    assert.deepEqual(change(start, await count()), { urgent: 1, open: 2 });

    // Acknowledged: someone is on it
    const [alert] = await alertsFor(urgent);
    await call(officer, 'public.iot_acknowledge_alert($1)', [alert.id]);
    assert.deepEqual(change(start, await count()), { urgent: 0, open: 1 });

    // Ended by itself: nothing going on, though it still waits to be resolved
    await send(routine, [{ ago: 30, soil_raw: await soilAt(50) }]);
    assert.deepEqual(change(start, await count()), { urgent: 0, open: 0 });

    // From an edge's backlog after an outage: kept, but not counted
    const late = await newNode({ settings: { quiet_minutes: 600 } });
    await send(late, [{ ago: 3 * 3600, temp_c: 48 }]);
    assert.equal((await alertsFor(late))[0].from_backlog, true);
    assert.deepEqual(change(start, await count()), { urgent: 0, open: 0 });
  });
});

describe('acknowledging and resolving', () => {
  async function openAlert() {
    const node = await newNode();
    await send(node, [{ ago: 60, motion: 1 }]);
    const [alert] = await alertsFor(node);
    return { node, id: alert.id };
  }

  test('both say who and when, for officers and admins', async () => {
    for (const user of [officer, admin]) {
      const { node, id } = await openAlert();
      const startedAt = new Date(Date.now() - 1000);
      assert.deepEqual(await call(user, 'public.iot_acknowledge_alert($1)', [id]), {
        id,
        status: 'acknowledged',
      });
      // Someone is on it, but it's still going on, so the node still shows the threat
      assert.equal(await statusOf(node), 'threat_triggered');
      assert.deepEqual(await call(user, 'public.iot_resolve_alert($1)', [id]), { id, status: 'resolved' });
      const [alert] = await alertsFor(node);
      assert.equal(alert.acknowledged_by, user.id);
      assert.equal(alert.acknowledged_by_name, user.name);
      assert.ok(alert.acknowledged_at >= startedAt);
      assert.equal(alert.resolved_by, user.id);
      assert.equal(alert.resolved_by_name, user.name);
      assert.ok(alert.resolved_at >= alert.acknowledged_at);
      assert.equal(await statusOf(node), 'online');
    }
  });

  test('an alert can be resolved without being acknowledged first', async () => {
    const { node, id } = await openAlert();
    await call(officer, 'public.iot_resolve_alert($1)', [id]);
    const [alert] = await alertsFor(node);
    assert.deepEqual([alert.status, alert.acknowledged_at], ['resolved', null]);
  });

  test('doing it twice keeps the first person', async () => {
    const { node, id } = await openAlert();
    await call(officer, 'public.iot_acknowledge_alert($1)', [id]);
    await call(admin, 'public.iot_acknowledge_alert($1)', [id]);
    await call(officer, 'public.iot_resolve_alert($1)', [id]);
    assert.deepEqual(await call(admin, 'public.iot_resolve_alert($1)', [id]), { id, status: 'resolved' });
    // Acknowledging a resolved alert changes nothing either
    assert.deepEqual(await call(admin, 'public.iot_acknowledge_alert($1)', [id]), { id, status: 'resolved' });
    const [alert] = await alertsFor(node);
    assert.equal(alert.acknowledged_by_name, 'Park officer');
    assert.equal(alert.resolved_by_name, 'Park officer');
  });

  test('anyone else is turned down and the alert stays as it was', async () => {
    const { node, id } = await openAlert();
    for (const user of [null, visitor, researcher, botanist]) {
      for (const fn of ['iot_acknowledge_alert', 'iot_resolve_alert']) {
        await assert.rejects(call(user, `public.${fn}($1)`, [id]), { code: '42501' }, `${who(user)} ${fn}`);
      }
    }
    assert.equal((await alertsFor(node))[0].status, 'open');
  });

  test('an alert that does not exist gets a clear answer', async () => {
    await assert.rejects(call(officer, 'public.iot_acknowledge_alert($1)', [987654321]), /no alert/);
    await assert.rejects(call(officer, 'public.iot_resolve_alert($1)', [987654321]), /no alert/);
  });

  test('a routine alert that is resolved takes the node back to online', async () => {
    const node = await newNode({ settings: { alert_types: ['RAIN', 'QUIET'] } });
    await send(node, [{ ago: 60, rain_raw: await rainAt(30) }]);
    assert.equal(await statusOf(node), 'warning');
    const [alert] = await alertsFor(node);
    await call(officer, 'public.iot_resolve_alert($1)', [alert.id]);
    assert.equal(await statusOf(node), 'online');
  });
});

describe('commands for the nodes', () => {
  const sendCommand = (user, node, command) => insertAs(db, user, 'public.iot_commands', { node_id: node, command });

  async function commandsFor(node) {
    const { rows } = await db.query('SELECT * FROM public.iot_commands WHERE node_id = $1 ORDER BY created_at', [node]);
    return rows;
  }

  test('officers and admins send one, and the database fills in who and when', async () => {
    const node = await newNode();
    for (const user of [officer, admin]) {
      await sendCommand(user, node, 'beep_on');
    }
    const commands = await commandsFor(node);
    assert.deepEqual(
      commands.map((c) => [c.command, c.status, c.created_by, c.created_by_name]),
      [
        ['beep_on', 'pending', officer.id, 'Park officer'],
        ['beep_on', 'pending', admin.id, 'Park admin'],
      ],
    );
    const hour = commands[0].expires_at.getTime() - commands[0].created_at.getTime();
    assert.equal(hour, 3600 * 1000);
  });

  test('nobody else can, and nobody picks the sender, the status or the times', async () => {
    const node = await newNode();
    for (const user of [visitor, researcher, botanist]) {
      await assert.rejects(sendCommand(user, node, 'beep_on'), notTheirRole, who(user));
    }
    await assert.rejects(sendCommand(null, node, 'beep_on'), notAllowed);
    for (const column of ['created_by_name', 'status', 'expires_at', 'result']) {
      await assert.rejects(
        insertAs(db, officer, 'public.iot_commands', { node_id: node, command: 'beep_on', [column]: null }),
        notAllowed,
        column,
      );
    }
    await assert.rejects(sendCommand(officer, node, 'self_destruct'), /check/);
    await sendCommand(officer, node, 'beep_off');
    for (const sql of [
      "UPDATE public.iot_commands SET status = 'done' WHERE node_id = $1",
      'DELETE FROM public.iot_commands WHERE node_id = $1',
    ]) {
      await assert.rejects(selectAs(db, admin, sql, [node]), notAllowed, sql);
    }
  });

  test('edge-com hands a command to its node’s edge, and follows it to the end', async () => {
    const node = await newNode();
    await sendCommand(officer, node, 'reset_baseline');
    const [command] = await commandsFor(node);

    // Another region's edge doesn't get it, and can't change it
    let answer = await upload(keyB, {
      edge_id: 'REGION-B',
      cal_since: Number.MAX_SAFE_INTEGER,
      command_updates: [{ id: command.id, status: 'done', done_at: new Date().toISOString() }],
    });
    assert.ok(!(answer.body?.commands ?? []).some((c) => c.id === command.id));
    assert.equal((await commandsFor(node))[0].status, 'pending');

    answer = await send(node, []);
    assert.equal(answer.status, 200);
    const handed = answer.body.commands.find((c) => c.id === command.id);
    assert.deepEqual([handed.node_id, handed.command], [node, 'reset_baseline']);

    const times = [3, 2, 1, 0].map((s) => new Date(Date.now() - s * 1000).toISOString());
    const at = (s) => times[3 - s];
    const report = (update) => send(node, [], { batch: { command_updates: [{ id: command.id, ...update }] } });
    await report({ status: 'at_edge', at_edge_at: at(3) });
    // Once the edge has it, it isn't handed out again
    answer = await send(node, []);
    assert.ok(!(answer.body?.commands ?? []).some((c) => c.id === command.id));
    await report({ status: 'sent', sent_at: at(2) });
    await report({ status: 'done', done_at: at(1), result: 'baseline 118.2 cm' });
    // An old report that arrives late doesn't take it back
    await report({ status: 'sent', sent_at: at(0) });
    const [done] = await commandsFor(node);
    assert.equal(done.status, 'done');
    assert.equal(done.result, 'baseline 118.2 cm');
    assert.equal(done.sent_at.toISOString(), at(2));
    assert.notEqual(done.at_edge_at, null);
    assert.notEqual(done.done_at, null);
  });

  test('a command no edge picked up within the hour expires', async () => {
    const node = await newNode();
    await sendCommand(officer, node, 'beep_on');
    await db.query("UPDATE public.iot_commands SET expires_at = now() - interval '1 second' WHERE node_id = $1", [node]);
    const answer = await upload(keyB, { edge_id: 'REGION-B', cal_since: Number.MAX_SAFE_INTEGER });
    assert.ok(!(answer.body?.commands ?? []).some((c) => c.node_id === node));
    const [command] = await commandsFor(node);
    assert.equal(command.status, 'expired');
    assert.notEqual(command.done_at, null);
  });

  test('an update that is not a real one is skipped and the rest of the batch goes in', async () => {
    const node = await newNode();
    const answer = await send(node, [{ ago: 10 }], {
      batch: {
        command_updates: [
          { id: 'not-a-uuid', status: 'done' },
          { id: '00000000-0000-4000-8000-000000000000', status: 'exploded' },
          { id: '00000000-0000-4000-8000-000000000000', status: 'done', done_at: 'yesterday' },
        ],
      },
    });
    // 200 if another test left a command waiting for this region's nodes
    assert.ok([200, 204].includes(answer.status), `${answer.status}`);
    assert.equal((await storedReadings(node)).length, 1);
  });
});

describe('calibration and alert settings', () => {
  let key;

  before(async () => {
    await insertAs(db, admin, 'public.iot_devices', { device_id: 'CAL-REGION', name: 'Calibration' });
    key = (await makeToken(admin, 'CAL-REGION')).token;
  });

  test('edge-com sends the settings the edge does not have yet, for its own nodes only', async () => {
    const first = await newNode({ device: 'CAL-REGION' });
    const second = await newNode({ device: 'CAL-REGION' });
    let answer = await upload(key, { edge_id: 'CAL-REGION', cal_since: 0 });
    assert.deepEqual(answer.body.calibration.map((c) => c.node_id), [first, second]);
    const [cal] = answer.body.calibration;
    assert.deepEqual(Object.keys(cal).sort(), [
      'alert_confirm_readings', 'alert_types', 'motion_confirm_readings', 'move_cm', 'node_id',
      'rain_dry_raw', 'rain_heavy_pct', 'rain_light_pct', 'rain_wet_raw', 'soil_dry_pct',
      'soil_dry_raw', 'soil_flood_pct', 'soil_wet_raw', 'v',
    ]);
    const newest = answer.body.calibration.at(-1).v;
    assert.equal((await upload(key, { edge_id: 'CAL-REGION', cal_since: newest })).status, 204);

    // A change to a setting the edge uses gives that node a new version
    await selectAs(db, admin, 'UPDATE public.iot_nodes SET soil_flood_pct = 90 WHERE node_id = $1', [first]);
    answer = await upload(key, { edge_id: 'CAL-REGION', cal_since: newest });
    assert.deepEqual(
      answer.body.calibration.map((c) => [c.node_id, c.soil_flood_pct]),
      [[first, 90]],
    );
    assert.ok(answer.body.calibration[0].v > newest);
  });

  test('a setting only the cloud uses, or setting cal_version itself, gives no new version', async () => {
    const node = await newNode({ device: 'CAL-REGION' });
    const version = async () => Number((await nodeRow(node)).cal_version);
    const before = await version();
    await selectAs(db, admin, 'UPDATE public.iot_nodes SET quiet_minutes = 30, too_hot_c = 40, too_hot_clear_c = 35 WHERE node_id = $1', [node]);
    assert.equal(await version(), before);
    await db.query('UPDATE public.iot_nodes SET cal_version = 1 WHERE node_id = $1', [node]);
    assert.equal(await version(), before);
  });

  test('only admins change the settings, and nonsense ones are turned down', async () => {
    const node = await newNode({ device: 'CAL-REGION' });
    const set = (user, sql) => selectAs(db, user, `UPDATE public.iot_nodes SET ${sql} WHERE node_id = $1 RETURNING node_id`, [node]);
    assert.deepEqual(await set(officer, 'move_cm = 20'), []);
    assert.equal((await nodeRow(node)).move_cm, 10);
    for (const [sql, rule] of [
      ['soil_flood_clear_pct = 90', /iot_nodes_cal_ranges/],
      ['soil_dry_raw = 1400', /iot_nodes_cal_ranges/],
      ['too_hot_c = 60', /check/],
      ['alert_types = ARRAY[\'FIRE\']', /check/],
      ['quiet_minutes = 0', /check/],
      ['alert_confirm_readings = 11', /check/],
    ]) {
      await assert.rejects(set(admin, sql), rule, sql);
    }
    assert.deepEqual(await set(admin, 'move_cm = 20, move_clear_cm = 15'), [{ node_id: node }]);
  });

  test('a node’s own settings decide its alerts straight away', async () => {
    const node = await newNode({ device: 'CAL-REGION', settings: { too_hot_c: 35, too_hot_clear_c: 33 } });
    await send(node, [{ ago: 60, temp_c: 36 }], { device: 'CAL-REGION', key });
    assert.deepEqual((await alertsFor(node)).map((a) => a.type), ['TOO_HOT']);
  });
});

describe('who reads and changes what', () => {
  const STAFF_READS = ['iot_readings', 'iot_alerts', 'iot_boots', 'iot_commands', 'iot_node_status', 'iot_devices', 'iot_nodes'];
  let node;

  before(async () => {
    node = await newNode();
    await send(node, [{ ago: 20, motion: 1 }], {
      batch: { boots: [{ node_id: node, boot_id: 1, lat: 3.81, lon: 113.78, at: new Date().toISOString() }] },
    });
    await insertAs(db, officer, 'public.iot_commands', { node_id: node, command: 'beep_on' });
  });

  test('only officers and admins read the sensor tables', async () => {
    for (const table of STAFF_READS) {
      for (const user of [officer, admin]) {
        const rows = await selectAs(db, user, `SELECT * FROM public.${table}`);
        assert.ok(rows.length > 0, `${who(user)} reading ${table}`);
      }
      for (const user of [visitor, researcher, botanist]) {
        assert.deepEqual(await selectAs(db, user, `SELECT * FROM public.${table}`), [], `${who(user)} reading ${table}`);
      }
      await assert.rejects(selectAs(db, null, `SELECT * FROM public.${table}`), notAllowed, `anon reading ${table}`);
    }
  });

  test('edge-com’s own tables are closed to everyone, admins included', async () => {
    for (const table of ['iot_device_tokens', 'iot_alert_state']) {
      for (const user of [null, officer, admin]) {
        await assert.rejects(selectAs(db, user, `SELECT * FROM public.${table}`), notAllowed, `${who(user)} ${table}`);
      }
    }
  });

  test('nobody adds, changes or removes a reading, an alert or a power-up directly, admins included', async () => {
    for (const user of [officer, admin]) {
      for (const sql of [
        "INSERT INTO public.iot_readings (device_id, node_id, boot_id, seq, recorded_at, ts_source, received_at) VALUES ('REGION-A', 'x', 1, 1, now(), 'edge', now())",
        'UPDATE public.iot_readings SET temp_c = 1',
        'DELETE FROM public.iot_readings',
        "INSERT INTO public.iot_alerts (node_id, node_name, device_id, type, severity, recorded_at, confirmed_recorded_at) VALUES ('x', 'x', 'REGION-A', 'QUIET', 'urgent', now(), now())",
        "UPDATE public.iot_alerts SET status = 'resolved', resolved_at = now()",
        'DELETE FROM public.iot_alerts',
        "INSERT INTO public.iot_boots (node_id, boot_id) VALUES ('x', 1)",
        'UPDATE public.iot_boots SET latitude = 1, longitude = 1',
        'DELETE FROM public.iot_boots',
      ]) {
        await assert.rejects(selectAs(db, user, sql), notAllowed, `${who(user)}: ${sql}`);
      }
    }
  });

  test('officers see the devices, and only admins add, change or remove one', async () => {
    await assert.rejects(
      insertAs(db, officer, 'public.iot_devices', { device_id: 'OFFICER-ADDS', name: 'No' }),
      notTheirRole,
    );
    assert.deepEqual(
      await selectAs(db, officer, "UPDATE public.iot_devices SET name = 'Renamed' WHERE device_id = 'REGION-A' RETURNING device_id"),
      [],
    );
    assert.deepEqual(
      await selectAs(db, officer, "DELETE FROM public.iot_devices WHERE device_id = 'HASH-TEST' RETURNING device_id"),
      [],
    );
    await insertAs(db, admin, 'public.iot_devices', {
      device_id: 'PLACED',
      name: 'Placed',
      zone: 'North',
      latitude: 3.81,
      longitude: 113.78,
    });
    const [placed] = await selectAs(db, officer, "SELECT * FROM public.iot_devices WHERE device_id = 'PLACED'");
    assert.deepEqual([placed.zone, placed.latitude, placed.longitude, placed.enabled], ['North', 3.81, 113.78, true]);
    // A position is both halves or neither, and on the Earth
    for (const sql of ['latitude = NULL', 'latitude = 91', 'longitude = -181']) {
      await assert.rejects(
        selectAs(db, admin, `UPDATE public.iot_devices SET ${sql} WHERE device_id = 'PLACED'`),
        /latitude|longitude/,
        sql,
      );
    }
    await assert.rejects(
      insertAs(db, admin, 'public.iot_devices', { device_id: 'x', name: 'Too short' }),
      /check/,
    );
  });

  test('only admins link a node to a device', async () => {
    const linked = await newNode({ device: null });
    const link = (user) =>
      selectAs(db, user, "UPDATE public.iot_nodes SET edge_device_id = 'REGION-B' WHERE node_id = $1 RETURNING node_id", [linked]);
    assert.deepEqual(await link(officer), []);
    assert.deepEqual(await link(admin), [{ node_id: linked }]);
  });

  test("a device or node with history can't be removed, and one without can", async () => {
    const remove = (table, column, id) =>
      selectAs(db, admin, `DELETE FROM public.${table} WHERE ${column} = $1 RETURNING ${column}`, [id]);
    await assert.rejects(remove('iot_devices', 'device_id', 'REGION-A'), { code: '23503' });
    await assert.rejects(remove('iot_nodes', 'node_id', node), { code: '23503' });

    const unused = await newNode({ device: 'PLACED' });
    assert.deepEqual(await remove('iot_nodes', 'node_id', unused), [{ node_id: unused }]);
    // Removing a device takes its token with it, and leaves its nodes unlinked
    const orphan = await newNode({ device: 'PLACED' });
    await makeToken(admin, 'PLACED');
    assert.deepEqual(await remove('iot_devices', 'device_id', 'PLACED'), [{ device_id: 'PLACED' }]);
    assert.equal((await nodeRow(orphan)).edge_device_id, null);
    const { rows } = await db.query("SELECT 1 FROM public.iot_device_tokens WHERE device_id = 'PLACED'");
    assert.deepEqual(rows, []);
  });

  test('every sensor table has Row Level Security on', async () => {
    const { rows } = await db.query(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'iot\\_%'
       ORDER BY relname`,
    );
    assert.deepEqual(
      rows.map((row) => row.relname),
      ['iot_alert_state', 'iot_alerts', 'iot_boots', 'iot_commands', 'iot_device_tokens', 'iot_devices', 'iot_nodes', 'iot_readings'],
    );
    for (const row of rows) assert.equal(row.relrowsecurity, true, row.relname);
  });

  test('every sensor function has its search path locked and only the grants it needs', async () => {
    const { rows } = await db.query(
      `SELECT p.oid::regprocedure::text AS fn, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
       FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'iot\\_%'
       ORDER BY 1`,
    );
    const forStaff = new Set([
      'iot_acknowledge_alert(bigint)',
      'iot_check_alerts()',
      'iot_make_device_token(text)',
      'iot_raw_pct(integer,integer,integer)',
      'iot_resolve_alert(bigint)',
    ]);
    assert.ok(rows.length >= 9);
    for (const row of rows) {
      assert.deepEqual(row.proconfig, ['search_path=""'], row.fn);
      assert.equal(row.anon, false, `anon runs ${row.fn}`);
      assert.equal(row.authenticated, forStaff.has(row.fn), `authenticated runs ${row.fn}`);
      if (!forStaff.has(row.fn)) assert.equal(row.service, false, `service_role runs ${row.fn}`);
    }
  });
});

describe('the status view for the Sensors page', () => {
  const view = async (node) =>
    (await selectAs(db, officer, 'SELECT * FROM public.iot_node_status WHERE node_id = $1', [node]))[0];

  test('it shows the newest reading, even when an older one arrives after it', async () => {
    const node = await newNode();
    await send(node, [{ ago: 60, temp_c: 30 }]);
    await send(node, [{ ago: 120, temp_c: 20 }]);
    const row = await view(node);
    assert.equal(row.temp_c, 30);
    assert.equal(row.last_reading_at.getTime(), (testNow - 60) * 1000);
  });

  test('it works out each state with the node’s own limits', async () => {
    const node = await newNode({ settings: { alert_types: ['QUIET'] } });
    // Each one a little newer than the one before
    let ago = 40;
    const states = async (changes) => {
      ago -= 10;
      await send(node, [{ ago, ...changes }]);
      const row = await view(node);
      return [row.temp_state, row.soil_state, row.rain_state, row.dist_state];
    };
    assert.deepEqual(await states({}), ['NORMAL', 'NORMAL', 'NONE', 'OK']);
    assert.deepEqual(
      await states({ temp_c: 45, soil_raw: await soilAt(85), rain_raw: await rainAt(20), dist_cm: 131 }),
      ['TOO_HOT', 'SATURATED', 'RAIN', 'MOVED'],
    );
    assert.deepEqual(
      await states({ soil_raw: await soilAt(20), rain_raw: await rainAt(60), dist_cm: null }),
      ['NORMAL', 'DRY', 'HEAVY', 'NO_ECHO'],
    );
    assert.deepEqual(await states({ temp_c: null, soil_raw: null, rain_raw: null }), [null, null, null, 'OK']);
  });

  test('it says when a node is quiet, and a node with no readings is empty and not quiet', async () => {
    const quiet = await newNode();
    await send(quiet, [{ ago: 20 * 60 }]);
    assert.equal((await view(quiet)).quiet, true);
    assert.equal((await view(quiet)).open_alerts, 1);

    const row = await view(await newNode());
    assert.equal(row.quiet, false);
    for (const column of ['last_reading_at', 'temp_c', 'soil_pct', 'soil_state', 'dist_state', 'motion']) {
      assert.equal(row[column], null, column);
    }
  });

  test('it counts alerts going on, and leaves out ended and resolved ones', async () => {
    const node = await newNode();
    await send(node, [{ ago: 120, motion: 1, temp_c: 46 }, { ago: 60, temp_c: 46 }, { ago: 30, temp_c: 46 }]);
    const row = await view(node);
    assert.deepEqual([Number(row.open_alerts), Number(row.urgent_alerts)], [1, 1]);
  });

  test('running 002 again leaves the nodes as they are', async () => {
    const everyNode = 'SELECT * FROM public.iot_nodes ORDER BY node_id';
    const before = (await db.query(everyNode)).rows;
    await db.exec(readSql('002_seed_data.sql'));
    assert.deepEqual((await db.query(everyNode)).rows, before);
  });

  test('the sample nodes from 002 start with no readings', async () => {
    const fresh = await newDatabase();
    try {
      const { rows } = await fresh.query(
        `SELECT n.node_id, n.status, n.last_heartbeat, n.edge_device_id, s.last_reading_at, s.quiet
         FROM public.iot_nodes AS n JOIN public.iot_node_status AS s USING (node_id)
         ORDER BY n.node_id`,
      );
      assert.deepEqual(rows, ['NNP-IOT-01', 'NNP-IOT-02', 'NNP-IOT-03'].map((node_id) => ({
        node_id, status: 'online', last_heartbeat: null, edge_device_id: null, last_reading_at: null, quiet: false,
      })));
    } finally {
      await fresh.close();
    }
  });

  test('only officers and admins get rows', async () => {
    for (const user of [visitor, researcher, botanist]) {
      assert.deepEqual(await selectAs(db, user, 'SELECT * FROM public.iot_node_status'), [], who(user));
    }
  });
});

describe('nothing from a node reaches the public', () => {
  test('anon has no grant on anything with iot_ in its name', async () => {
    const { rows } = await db.query(
      `SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'iot\\_%' AND relkind IN ('r', 'v')
         AND (has_table_privilege('anon', oid, 'SELECT') OR has_table_privilege('anon', oid, 'INSERT')
           OR has_table_privilege('anon', oid, 'UPDATE') OR has_table_privilege('anon', oid, 'DELETE'))`,
    );
    assert.deepEqual(rows, []);
  });

  test('no view other than the staff one reads the sensor tables', async () => {
    const { rows } = await db.query(
      `SELECT DISTINCT view_name FROM information_schema.view_table_usage
       WHERE table_schema = 'public' AND table_name LIKE 'iot\\_%'`,
    );
    assert.deepEqual(rows, [{ view_name: 'iot_node_status' }]);
  });

  test("a node's position is only in iot_boots, which only officers and admins read", async () => {
    const { rows } = await db.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'iot\\_%' AND column_name IN ('latitude', 'longitude')
       ORDER BY table_name`,
    );
    // The edge devices have a position too: they sit at a ranger station, not by a plant
    assert.deepEqual(rows.map((row) => row.table_name), ['iot_boots', 'iot_devices']);
  });
});

describe('the order the files run in', () => {
  test('each sensor file stops on its first line if the one before it has not been run', async () => {
    let ran = SQL_FILES.indexOf('015_species_rough_area.sql');
    const fresh = await newDatabase(SQL_FILES.slice(0, ran));
    try {
      // Each file and the one it needs before it. 022 needs 021, which runs after 017 like 019
      // and 020.
      const needs = [['016_1_iot_devices.sql', '015_species_rough_area.sql']];
      for (let i = 1; i < IOT_FILES.length; i += 1) {
        needs.push([IOT_FILES[i], IOT_FILES[i] === '022_iot_reading_limit.sql' ? '021_role_changes.sql' : IOT_FILES[i - 1]]);
      }
      for (const [file, before] of needs) {
        const prefix = file.split('_iot_')[0];
        await assert.rejects(
          fresh.exec(readSql(file)),
          { message: `${prefix} needs ${before} to be run first` },
          file,
        );
        // Everything up to the one it needs
        for (; ran <= SQL_FILES.indexOf(before); ran += 1) await fresh.exec(readSql(SQL_FILES[ran]));
      }
      await fresh.exec(readSql(IOT_FILES.at(-1)));
    } finally {
      await fresh.close();
    }
  });
});

describe('running the sensor files again', () => {
  test('ends up the same, and keeps the readings, the tokens, the settings and the alerts', async () => {
    const again = await newDatabase();
    const otherEdge = await startEdgeCom(again, { output: { log() {}, warn() {}, error: console.error } });
    try {
      const owner = await addUser(again, { role: 'admin', name: 'Owner' });
      await insertAs(again, owner, 'public.iot_devices', { device_id: 'AGAIN', name: 'Again' });
      const { rows: made } = await asUser(again, owner, (tx) => tx.query("SELECT public.iot_make_device_token('AGAIN') AS t"));
      const key = made[0].t.token;
      await again.query("UPDATE public.iot_nodes SET edge_device_id = 'AGAIN', soil_flood_pct = 88 WHERE node_id = (SELECT min(node_id) FROM public.iot_nodes)");
      const node = (await again.query("SELECT node_id FROM public.iot_nodes WHERE edge_device_id = 'AGAIN'")).rows[0].node_id;
      const rows = [[1, nowSeconds() - 30, 1, 26, 80, 2600, 4095, 120, 120, 0, -60, 1]];
      await otherEdge.upload(key, { edge_id: 'AGAIN', nodes: [{ node_id: node, boot_id: 1, rows }] });

      const snapshot = async () => {
        const parts = {};
        for (const [name, sql] of Object.entries({
          columns: `SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name LIKE 'iot\\_%' ORDER BY 1, 2`,
          policies: "SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE tablename LIKE 'iot\\_%' ORDER BY 1, 2",
          grants: `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
                   WHERE table_schema = 'public' AND table_name LIKE 'iot\\_%' ORDER BY 1, 2, 3`,
          constraints: "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid::regclass::text LIKE 'iot\\_%' ORDER BY 1",
          readings: 'SELECT count(*)::int AS n FROM public.iot_readings',
          alerts: 'SELECT type, status FROM public.iot_alerts ORDER BY id',
          settings: 'SELECT node_id, soil_flood_pct, edge_device_id, cal_version FROM public.iot_nodes ORDER BY node_id',
          token: "SELECT encode(token_hash, 'hex') AS h FROM public.iot_device_tokens",
        })) {
          parts[name] = (await again.query(sql)).rows;
        }
        return parts;
      };
      const first = await snapshot();
      assert.equal(first.alerts.length, 1);
      for (const file of IOT_FILES) await again.exec(readSql(file));
      assert.deepEqual(await snapshot(), first);
      // And the token still works
      assert.equal((await otherEdge.upload(key, { edge_id: 'AGAIN', cal_since: Number.MAX_SAFE_INTEGER })).status, 204);
    } finally {
      await otherEdge.close();
      await again.close();
    }
  });
});

describe('through the stand-in, the way an edge and the website do it', () => {
  const [officerLogin, adminLogin, botanistLogin, , visitorLogin] = TEST_USERS;
  const representation = { Prefer: 'return=representation' };
  let standIn;
  const tokens = {};
  let deviceToken;

  /** Calls the stand-in like supabase-js. It gives back the status and the parsed answer. */
  async function api(path, { method = 'GET', token = ANON_KEY, body, headers = {} } = {}) {
    const response = await fetch(`${standIn.url}${path}`, {
      method,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  /** Uploads the way cloud-com.py does: gzipped, with only the device's token, no anon key. */
  async function edgeUpload(key, batch) {
    const response = await fetch(`${standIn.url}/functions/v1/edge-com`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'x-edge-key': key },
      body: gzipSync(JSON.stringify(batch)),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function signIn(user) {
    const { body } = await api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: user.email, password: TEST_PASSWORD },
    });
    return body.access_token;
  }

  before(async () => {
    standIn = await startStandIn({ port: 0, log: () => {}, sensorData: false });
    tokens.officer = await signIn(officerLogin);
    tokens.admin = await signIn(adminLogin);
    tokens.botanist = await signIn(botanistLogin);
    tokens.visitor = await signIn(visitorLogin);
  });

  after(() => standIn.close());

  test('an admin adds a device with its position, links a node and makes a token', async () => {
    const added = await api('/rest/v1/iot_devices', {
      method: 'POST',
      token: tokens.admin,
      headers: representation,
      body: { device_id: 'HTTP-REGION', name: 'HTTP region', latitude: 3.8149, longitude: 113.7797 },
    });
    assert.equal(added.status, 201);

    const linked = await api('/rest/v1/iot_nodes?node_id=eq.NNP-IOT-01&select=node_id', {
      method: 'PATCH',
      token: tokens.admin,
      headers: representation,
      body: { edge_device_id: 'HTTP-REGION' },
    });
    assert.deepEqual([linked.status, linked.body], [200, [{ node_id: 'NNP-IOT-01' }]]);

    const made = await api('/rest/v1/rpc/iot_make_device_token', {
      method: 'POST',
      token: tokens.admin,
      body: { device: 'HTTP-REGION' },
    });
    assert.equal(made.status, 200);
    deviceToken = made.body.token;
    assert.match(deviceToken, /^niah_device_/);

    const officerTry = await api('/rest/v1/rpc/iot_make_device_token', {
      method: 'POST',
      token: tokens.officer,
      body: { device: 'HTTP-REGION' },
    });
    assert.equal(officerTry.status, 403);
  });

  test('an edge uploads with its token and no anon key, and nothing goes in without it', async () => {
    const now = nowSeconds();
    const batch = {
      edge_id: 'HTTP-REGION',
      nodes: [{ node_id: 'NNP-IOT-01', boot_id: 5, rows: [[1, now - 20, 1, 26, 80, 2600, 4095, 131, 120, 0, -61, 0]] }],
      boots: [{ node_id: 'NNP-IOT-01', boot_id: 5, lat: 3.8155, lon: 113.779, at: new Date().toISOString() }],
    };
    const first = await edgeUpload(deviceToken, batch);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.calibration.map((c) => c.node_id), ['NNP-IOT-01']);

    const wrong = await edgeUpload('wrong-but-long-enough', batch);
    assert.deepEqual(wrong, notThisDevice);
    const unknown = await edgeUpload(deviceToken, { ...batch, edge_id: 'NO-SUCH-DEVICE' });
    assert.deepEqual(unknown, notThisDevice);
    const { rows } = await standIn.db.query("SELECT count(*)::int AS n FROM public.iot_readings WHERE node_id = 'NNP-IOT-01'");
    assert.equal(rows[0].n, 1);
  });

  test('the anon key reads nothing back', async () => {
    for (const table of ['iot_readings', 'iot_alerts', 'iot_boots', 'iot_commands', 'iot_devices', 'iot_device_tokens', 'iot_node_status']) {
      const { status } = await api(`/rest/v1/${table}?select=*`);
      assert.equal(status, 401, table);
    }
  });

  test('officers read what the Sensors page reads, and a botanist or visitor gets nothing', async () => {
    // The same reads as the Sensors page, as supabase-js sends them
    const paths = [
      'iot_node_status?select=node_id,dist_state,open_alerts',
      'iot_alerts?select=id,type,status&status=neq.resolved',
      'iot_readings?select=recorded_at,dist_cm&node_id=eq.NNP-IOT-01&order=recorded_at.desc&limit=180',
      'iot_boots?select=node_id,latitude,longitude,position_at&latitude=not.is.null&order=position_at.desc.nullslast&limit=500',
      'iot_devices?select=device_id,latitude,longitude&order=device_id',
    ];
    for (const path of paths) {
      const staff = await api(`/rest/v1/${path}`, { token: tokens.officer });
      assert.equal(staff.status, 200, path);
      assert.ok(staff.body.length > 0, path);
      for (const token of [tokens.botanist, tokens.visitor]) {
        assert.deepEqual((await api(`/rest/v1/${path}`, { token })).body, [], path);
      }
    }
    const { body } = await api('/rest/v1/iot_node_status?select=dist_state,open_alerts&node_id=eq.NNP-IOT-01', {
      token: tokens.officer,
    });
    assert.deepEqual(body, [{ dist_state: 'MOVED', open_alerts: 1 }]);
  });

  test('an officer acknowledges and resolves through the API, and a botanist cannot', async () => {
    const counts = await api('/rest/v1/rpc/iot_check_alerts', { method: 'POST', token: tokens.officer, body: {} });
    assert.deepEqual(counts.body, { urgent: 1, open: 1 });

    const list = await api('/rest/v1/iot_alerts?status=eq.open&select=id', { token: tokens.officer });
    const alert = list.body[0].id;

    const refused = await api('/rest/v1/rpc/iot_acknowledge_alert', { method: 'POST', token: tokens.botanist, body: { alert } });
    assert.equal(refused.status, 403);
    const noCount = await api('/rest/v1/rpc/iot_check_alerts', { method: 'POST', token: tokens.visitor, body: {} });
    assert.equal(noCount.status, 403);

    const seen = await api('/rest/v1/rpc/iot_acknowledge_alert', { method: 'POST', token: tokens.officer, body: { alert } });
    assert.deepEqual(seen.body, { id: alert, status: 'acknowledged' });
    const done = await api('/rest/v1/rpc/iot_resolve_alert', { method: 'POST', token: tokens.officer, body: { alert } });
    assert.deepEqual(done.body, { id: alert, status: 'resolved' });

    const after = await api(`/rest/v1/iot_alerts?id=eq.${alert}&select=acknowledged_by_name,resolved_by_name`, { token: tokens.officer });
    assert.deepEqual(after.body, [{ acknowledged_by_name: officerLogin.name, resolved_by_name: officerLogin.name }]);
  });

  test('an officer sends a command from the website, and the edge gets it with its next upload', async () => {
    const sent = await api('/rest/v1/iot_commands', {
      method: 'POST',
      token: tokens.officer,
      body: { node_id: 'NNP-IOT-01', command: 'beep_on' },
    });
    assert.equal(sent.status, 201);
    const botanistTry = await api('/rest/v1/iot_commands', {
      method: 'POST',
      token: tokens.botanist,
      body: { node_id: 'NNP-IOT-01', command: 'beep_on' },
    });
    assert.equal(botanistTry.status, 403);

    const answer = await edgeUpload(deviceToken, { edge_id: 'HTTP-REGION', cal_since: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(
      answer.body.commands.map((c) => [c.node_id, c.command]),
      [['NNP-IOT-01', 'beep_on']],
    );
    const { body } = await api('/rest/v1/iot_commands?select=status,created_by_name', { token: tokens.officer });
    assert.deepEqual(body, [{ status: 'pending', created_by_name: officerLogin.name }]);
  });

  test('without the sensor files there is no edge-com, like a project where it isn’t deployed', async () => {
    const older = await startStandIn({ port: 0, log: () => {}, sqlThrough: '015' });
    try {
      assert.equal(older.edgeCom, false);
      const response = await fetch(`${older.url}/functions/v1/edge-com`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 404);
    } finally {
      await older.close();
    }
  });
});

describe('the stand-in’s made-up sensor data', () => {
  let standIn;

  before(async () => {
    standIn = await startStandIn({ port: 0, log: () => {} });
  });

  after(() => standIn.close());

  test('a day of readings from three nodes, with a position each, on the test device', async () => {
    const { rows } = await standIn.db.query(
      `SELECT r.node_id, count(*)::int AS n, b.latitude IS NOT NULL AS placed
       FROM public.iot_readings AS r JOIN public.iot_boots AS b USING (node_id, boot_id)
       WHERE r.device_id = $1 GROUP BY r.node_id, b.latitude ORDER BY r.node_id`,
      [TEST_DEVICE_ID],
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(row.n > 100, row.node_id);
      assert.equal(row.placed, true, row.node_id);
    }
  });

  test('one node of each kind for the Sensors page: urgent, routine and quiet', async () => {
    const { rows: nodes } = await standIn.db.query(
      'SELECT status FROM public.iot_nodes WHERE edge_device_id = $1 ORDER BY node_id LIMIT 3',
      [TEST_DEVICE_ID],
    );
    assert.deepEqual(nodes.map((n) => n.status), ['threat_triggered', 'warning', 'offline']);
    const { rows: alerts } = await standIn.db.query(
      'SELECT type, from_backlog, cleared_at IS NOT NULL AS ended FROM public.iot_alerts ORDER BY id',
    );
    assert.deepEqual(alerts, [
      { type: 'SATURATED', from_backlog: false, ended: false },
      { type: 'MOVED', from_backlog: false, ended: true },
      { type: 'RAIN', from_backlog: false, ended: false },
      { type: 'QUIET', from_backlog: false, ended: false },
    ]);
    const { rows: commands } = await standIn.db.query('SELECT command, status FROM public.iot_commands ORDER BY created_at');
    assert.deepEqual(commands, [
      { command: 'beep_on', status: 'done' },
      { command: 'beep_off', status: 'done' },
    ]);
  });
});
