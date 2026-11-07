// Checks 022: one edge device can add up to 3,600 readings an hour through edge-com, an upload
// that goes over is refused whole with HTTP 429, and other devices, older readings and readings
// sent twice don't count. PGlite has one connection, so two uploads at the same moment can't be
// run here. The lock in 022 is what covers that. The last part does it through the stand-in, the
// way cloud-com on an edge sends.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { EDGE_COM_RUNS, startEdgeCom } from './edge-com.js';
import { addUser, asUser, insertAs, newDatabase, readSql, SQL_FILES } from './harness.js';
import { startStandIn, TEST_DEVICE_ID, TEST_DEVICE_TOKEN } from './stand-in.js';

const FILE = '022_iot_reading_limit.sql';
const MOST = 3600;
const TOO_MANY = /too many readings in the last hour/;

let db;
let edge;
let admin;
let deviceCount = 0;
let seq = 0;
let fills = 0;

before(async () => {
  assert.ok(EDGE_COM_RUNS, 'These tests run edge-com, which needs Node 22.13 or newer');
  db = await newDatabase();
  edge = await startEdgeCom(db, { output: { log() {}, warn() {}, error: console.error } });
  admin = await addUser(db, { role: 'admin', name: 'Park admin' });
});

after(async () => {
  await edge.close();
  await db.close();
});

/** A new device with a token and one node, so each test has its own count. */
async function newDevice() {
  deviceCount += 1;
  const device = `LIMIT-${deviceCount}`;
  const node = `LIMIT-NODE-${deviceCount}`;
  await insertAs(db, admin, 'public.iot_devices', { device_id: device, name: `Limit ${deviceCount}` });
  await db.query(
    'INSERT INTO public.iot_nodes (node_id, name, zone, edge_device_id) VALUES ($1, $2, $3, $4)',
    [node, `Limit node ${deviceCount}`, 'Test zone', device],
  );
  const { rows } = await asUser(db, admin, (tx) =>
    tx.query('SELECT public.iot_make_device_token($1) AS value', [device]),
  );
  return { device, node, token: rows[0].value.token };
}

/** One calm reading as the edge sends it: [seq, ts, lag, temp, hum, soil, rain, dist, baseline, beep, rssi, motion]. */
function row() {
  seq += 1;
  return [seq, Math.floor(Date.now() / 1000) - 5, 1, 26, 80, 2000, 4095, 120, 120, 0, -60, 0];
}

/**
 * An upload from the device, the way cloud-com sends one. It says it has every calibration, so
 * edge-com answers 204 when it's stored and there's nothing to send back.
 */
async function send({ device, node, token }, rows) {
  const response = await edge.upload(token, {
    edge_id: device,
    nodes: [{ node_id: node, boot_id: 1, rows }],
    cal_since: Number.MAX_SAFE_INTEGER,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * Puts readings straight in the table with the triggers off, so a test can start close to the
 * limit without sending thousands. They count as stored at the time given, or now.
 */
function fill(database, device, node, count, insertedAt = null) {
  return database.transaction(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(
      `INSERT INTO public.iot_readings
         (device_id, node_id, boot_id, seq, recorded_at, ts_source, received_at, inserted_at)
       SELECT $1, $2, $3, n, now() - interval '3 hours', 'device', now() - interval '3 hours',
              coalesce($4::timestamptz, now())
       FROM generate_series(1, $5::int) AS n`,
      [device, node, 1_000_000 + (fills += 1), insertedAt, count],
    );
  });
}

async function countFor(device) {
  const { rows } = await db.query('SELECT count(*)::int AS count FROM public.iot_readings WHERE device_id = $1', [device]);
  return rows[0].count;
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('the hourly limit', () => {
  test('a device can add up to 3,600 readings in an hour', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST - 2);
    const answer = await send(one, [row(), row()]);
    assert.equal(answer.status, 204);
    assert.equal(await countFor(one.device), MOST);
  });

  test('an upload that goes over is refused whole, and a smaller one that fits works', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST - 1);
    const before = async () =>
      (
        await db.query(
          `SELECT d.last_heard_at, n.last_heartbeat,
             (SELECT count(*)::int FROM public.iot_alerts AS a WHERE a.node_id = n.node_id) AS alerts
           FROM public.iot_devices AS d JOIN public.iot_nodes AS n ON n.edge_device_id = d.device_id
           WHERE d.device_id = $1`,
          [one.device],
        )
      ).rows;
    const first = await before();

    const over = await send(one, [row(), row()]);
    assert.equal(over.status, 429);
    assert.match(over.body.error, TOO_MANY);
    assert.equal(await countFor(one.device), MOST - 1, 'the first of the two is not kept either');
    assert.deepEqual(await before(), first, 'a refused upload changes nothing, not even when it was heard from');

    assert.equal((await send(one, [row()])).status, 204);
    assert.equal((await send(one, [row()])).status, 429);
    assert.equal(await countFor(one.device), MOST);
  });

  test('the database error says what the limit is and what to do', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO public.iot_readings (device_id, node_id, boot_id, seq, recorded_at, ts_source, received_at)
           VALUES ($1, $2, 7, 1, now(), 'device', now())`,
          [one.device, one.node],
        );
      }),
      (error) => {
        assert.equal(error.code, 'PT429');
        assert.match(error.message, TOO_MANY);
        assert.equal(error.detail, 'One device can send 3600 readings an hour.');
        assert.equal(error.hint, 'Send them again later.');
        return true;
      },
    );
  });

  test('each device has its own count', async () => {
    const full = await newDevice();
    const other = await newDevice();
    await fill(db, full.device, full.node, MOST);
    assert.equal((await send(full, [row()])).status, 429);
    assert.equal((await send(other, [row()])).status, 204);
  });

  test('readings stored more than an hour ago no longer count, however old they are', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST, minutesAgo(61));
    await fill(db, one.device, one.node, MOST - 1, minutesAgo(59));
    assert.equal((await send(one, [row()])).status, 204);
    assert.equal((await send(one, [row()])).status, 429);
  });

  test('a reading sent again is skipped and does not count', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST - 1);
    const last = row();
    assert.equal((await send(one, [last])).status, 204);
    assert.equal((await send(one, [last])).status, 204, 'sending it again is fine');
    assert.equal(await countFor(one.device), MOST);
    assert.equal((await send(one, [row()])).status, 429);
  });

  test('an upload with no readings still goes through when the device is at the limit', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST);
    assert.equal((await edge.upload(one.token, { edge_id: one.device, cal_since: Number.MAX_SAFE_INTEGER })).status, 204);
  });

  test('a wrong token is still turned away before the count', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST);
    assert.equal((await send({ ...one, token: 'not-the-token' }, [row()])).status, 401);
  });
});

describe('the order the files run in', () => {
  const triggers = async (database) =>
    (await database.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = 'iot_limit_readings'")).rows;

  test('022 stops on its first line if 021 has not been run', async () => {
    const partWay = await newDatabase(SQL_FILES.slice(0, SQL_FILES.indexOf('021_role_changes.sql')));
    try {
      await assert.rejects(partWay.exec(readSql(FILE)), { message: '022 needs 021_role_changes.sql to be run first' });
      assert.deepEqual(await triggers(partWay), [{ count: 0 }]);
    } finally {
      await partWay.close();
    }
  });

  test('022 stops on its first line if the readings table is not the one from 016_4', async () => {
    const partWay = await newDatabase(SQL_FILES.slice(0, SQL_FILES.indexOf(FILE)));
    try {
      await partWay.exec('ALTER TABLE public.iot_readings RENAME COLUMN inserted_at TO stored_at');
      await assert.rejects(partWay.exec(readSql(FILE)), { message: '022 needs 016_4_iot_readings.sql to be run first' });
      assert.deepEqual(await triggers(partWay), [{ count: 0 }]);
    } finally {
      await partWay.close();
    }
  });
});

describe('running 022 again', () => {
  async function catalogs() {
    const queries = [
      `SELECT p.prosrc, p.prosecdef, p.proconfig,
         ARRAY(SELECT acl::text FROM unnest(p.proacl) AS acl ORDER BY 1) AS acl
       FROM pg_proc AS p
       WHERE p.oid = 'public.iot_limit_readings()'::regprocedure`,
      `SELECT tgname, tgtype, tgenabled::text AS enabled
       FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid = 'public.iot_readings'::regclass
       ORDER BY 1`,
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'iot_readings' ORDER BY 1",
    ];
    const results = [];
    for (const query of queries) results.push((await db.query(query)).rows);
    return results;
  }

  test('ends up the same, with one trigger, and keeps the limit', async () => {
    const one = await newDevice();
    await fill(db, one.device, one.node, MOST);
    const firstTime = await catalogs();
    await db.exec(readSql(FILE));
    assert.deepEqual(await catalogs(), firstTime);
    assert.equal(firstTime[1].filter((trigger) => trigger.tgname === 'iot_limit_readings').length, 1);
    assert.equal((await send(one, [row()])).status, 429);
  });
});

describe('through the stand-in, the way an edge device sends', () => {
  let standIn;

  before(async () => {
    standIn = await startStandIn({ port: 0, log: () => {}, sensorData: false });
  });

  after(() => standIn.close());

  async function upload(node, rows) {
    const response = await fetch(`${standIn.url}/functions/v1/edge-com`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'x-edge-key': TEST_DEVICE_TOKEN },
      body: gzipSync(JSON.stringify({ edge_id: TEST_DEVICE_ID, nodes: [{ node_id: node, boot_id: 1, rows }] })),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  test('a device over the limit gets HTTP 429, and a 2xx again once it fits', async () => {
    const { rows } = await standIn.db.query(
      'SELECT node_id FROM public.iot_nodes WHERE edge_device_id = $1 ORDER BY node_id LIMIT 1',
      [TEST_DEVICE_ID],
    );
    const node = rows[0].node_id;

    const first = await upload(node, [row()]);
    assert.ok(first.status >= 200 && first.status < 300, `HTTP ${first.status}`);

    await fill(standIn.db, TEST_DEVICE_ID, node, MOST - 1);
    const over = await upload(node, [row()]);
    assert.equal(over.status, 429);
    assert.match(over.body.error, TOO_MANY);

    await standIn.db.query(
      "UPDATE public.iot_readings SET inserted_at = now() - interval '2 hours' WHERE device_id = $1",
      [TEST_DEVICE_ID],
    );
    const again = await upload(node, [row()]);
    assert.ok(again.status >= 200 && again.status < 300, `HTTP ${again.status}`);
  });
});
