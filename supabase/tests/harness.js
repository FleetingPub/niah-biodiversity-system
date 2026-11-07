// Builds a throwaway Postgres in memory with PGlite, runs our SQL files on it in the same order
// as on Supabase, and lets a test act as different users the way the Supabase API does.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const supabaseFolder = new URL('../', import.meta.url);

/** Our SQL files, in the order they run on Supabase. */
export const SQL_FILES = [
  '001_initial_schema.sql',
  '002_seed_data.sql',
  '003_profiles_read_own.sql',
  '004_security_hardening.sql',
  '005_phone_sync.sql',
  '006_role_based_access.sql',
  '007_species_fixes.sql',
  '008_record_edits.sql',
  '009_species_photos.sql',
  '010_deleted_records.sql',
  '011_exact_location_downloads.sql',
  '012_report_counts.sql',
  '013_edit_history.sql',
  '014_photo_folder.sql',
  '015_species_rough_area.sql',
  '016_1_iot_devices.sql',
  '016_2_iot_nodes.sql',
  '016_3_iot_device_tokens.sql',
  '016_4_iot_readings.sql',
  '017_iot_alerts.sql',
  '019_public_record_details.sql',
  '020_record_photo_access.sql',
  '021_role_changes.sql',
  '022_iot_reading_limit.sql',
  '023_iot_boots.sql',
  '024_iot_alert_state.sql',
  '025_iot_commands.sql',
];

export function readSql(file) {
  return readFileSync(new URL(file, supabaseFolder), 'utf8');
}

export function readFixture(file) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'));
}

/**
 * A new database with the Supabase stand-ins, then our SQL files run as the postgres user. It runs
 * every file unless it's given a shorter list, for checking what a file does when an earlier one
 * hasn't been run.
 */
export async function newDatabase(files = SQL_FILES) {
  const db = await PGlite.create({ extensions: { uuid_ossp } });
  await db.exec(readFileSync(new URL('./supabase-stub.sql', import.meta.url), 'utf8'));
  for (const file of files) {
    let sql = readSql(file);
    if (file === '001_initial_schema.sql') {
      // PGlite doesn't come with PostGIS, and nothing in our SQL uses it yet.
      const withoutPostgis = sql.replace('CREATE EXTENSION IF NOT EXISTS "postgis";', '');
      assert.notEqual(withoutPostgis, sql, '001 no longer turns on PostGIS the way we expect');
      sql = withoutPostgis;
    }
    await db.exec(sql);
  }
  return db;
}

/**
 * Signs someone up the way Supabase Auth does, so the trigger from 004 makes them a visitor, then
 * gives them a role the way an admin would in the Table Editor.
 */
export async function addUser(db, { role = 'visitor', name = 'Test user' } = {}) {
  const id = randomUUID();
  await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
    id,
    `${id}@example.test`,
    JSON.stringify({ name }),
  ]);
  if (role !== 'visitor') {
    await db.query('UPDATE public.profiles SET role = $1 WHERE id = $2', [role, id]);
  }
  return { id, role, name };
}

/**
 * Runs fn in a transaction as a signed in user, or as someone who isn't signed in when user is
 * null. The Supabase API does the same for every request: it switches to the anon or
 * authenticated role and puts the user's ID where auth.uid() reads it. The transaction is saved
 * if fn works and undone if it throws, also like the API.
 */
export function asUser(db, user, fn) {
  return db.transaction(async (tx) => {
    const role = user ? 'authenticated' : 'anon';
    const claims = user ? { sub: user.id, role } : { role };
    await tx.query(
      "SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true)",
      [role, JSON.stringify(claims)],
    );
    return fn(tx);
  });
}

/**
 * Inserts a row the way the Supabase API does for supabase.from(table).insert(row): only the
 * columns in the row are named, so a column left out gets its default.
 */
export function insertAs(db, user, table, row) {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ');
  return asUser(db, user, (tx) =>
    tx.query(
      `INSERT INTO ${table} (${columns})
       SELECT ${columns} FROM json_populate_record(null::${table}, $1::json)`,
      [JSON.stringify(row)],
    ),
  );
}

/** Reads rows as a user, like a select through the Supabase API. */
export async function selectAs(db, user, sql, params = []) {
  const result = await asUser(db, user, (tx) => tx.query(sql, params));
  return result.rows;
}

/** A new record ID that starts with the given hex, for making tag codes clash on purpose. */
export function idStartingWith(hex) {
  const id = randomUUID().replace(/-/g, '');
  const joined = (hex + id.slice(hex.length)).toLowerCase();
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-');
}
