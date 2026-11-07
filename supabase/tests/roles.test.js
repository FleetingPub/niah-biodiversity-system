// Checks 006_role_based_access.sql: what each kind of user can read and change. Every test goes
// through the anon and authenticated roles the same way the Supabase API does, so it shows what
// someone could do with the anon key and their own login, even without the website or the app.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  SQL_FILES,
  addUser,
  asUser,
  insertAs,
  newDatabase,
  readFixture,
  readSql,
  selectAs,
} from './harness.js';

const { uploads } = readFixture('phone-upload.json');
const [everyField] = uploads;

// The seed records from 002, and the middle of the grid square each one shows the public. None of
// the seed species is both unprotected and Least Concern or Near Threatened, so all six only show
// a square. Worked out by hand, because floor() on JavaScript numbers can pick the wrong square
// right at an edge.
const seedSquares = {
  '2a1b0c9d-8e7f-6a5b-4c3d-2e1f0a9b8c06': { lat: 3.818, lng: 113.786, accuracyM: 440 },
  '3f2a9c4e-8b1d-4c6a-9e2f-7a1b5c3d9e01': { lat: 3.814, lng: 113.778, accuracyM: 440 },
  '5e9a2c71-7f4b-4d2e-8c9a-3b6d1e5f7a04': { lat: 3.818, lng: 113.778, accuracyM: 440 },
  '8c41e7b2-5d3f-4a9e-b6c1-2e8f4a7d1c02': { lat: 3.818, lng: 113.774, accuracyM: 440 },
  '9f8e7d6c-5b4a-3a2b-1c0d-9e8f7a6b5c05': { lat: 3.822, lng: 113.786, accuracyM: 440 },
  'b17d03f9-2c6e-4f8a-a3d5-9e1c7b4f2a03': { lat: 3.81, lng: 113.782, accuracyM: 440 },
};
const belianId = '3f2a9c4e-8b1d-4c6a-9e2f-7a1b5c3d9e01';

// A made up spot near park HQ for the test records, and the two ways the public can see it.
const spot = { lat: 3.8151, lng: 113.7801, accuracyM: 8, capturedAt: '2026-10-16T01:10:00.000Z' };
const exactSpot = { lat: 3.8151, lng: 113.7801, accuracyM: 8 };
const spotSquare = { lat: 3.814, lng: 113.782, accuracyM: 440 };

let db;
let visitor;
let researcher;
let botanist;
let otherBotanist;
let officer;
let admin;

before(async () => {
  db = await newDatabase();
  visitor = await addUser(db, { name: 'Visitor' });
  researcher = await addUser(db, { role: 'researcher', name: 'Researcher' });
  botanist = await addUser(db, { role: 'botanist', name: 'Field botanist' });
  otherBotanist = await addUser(db, { role: 'botanist', name: 'Second botanist' });
  officer = await addUser(db, { role: 'conservation_officer', name: 'Park officer' });
  admin = await addUser(db, { role: 'admin', name: 'Park admin' });
});

after(async () => {
  await db.close();
});

/** Runs one statement as a user, like one request through the Supabase API. */
function run(user, sql, params = []) {
  return asUser(db, user, (tx) => tx.query(sql, params));
}

/** How many rows a change touched. Rows the user isn't allowed to change are skipped, so 0. */
async function changed(user, sql, params = []) {
  return (await run(user, sql, params)).affectedRows;
}

function who(user) {
  return user?.name ?? 'someone not signed in';
}

const notAllowed = { code: '42501', message: /permission denied/ };
const turnedDown = { code: '42501', message: /row-level security/ };

/** Uploads a record like the phone does, at the made up spot, and gives back its ID. */
async function upload(user, changes = {}) {
  const row = { ...structuredClone(everyField.row), id: randomUUID(), gps: spot, ...changes };
  await insertAs(db, user, 'public.records', row);
  return row.id;
}

/** Reads a record straight from the table as the postgres user, so no rules get in the way. */
async function storedRecord(id) {
  const { rows } = await db.query('SELECT * FROM public.records WHERE id = $1', [id]);
  return rows[0];
}

/** Changes a record's status as the postgres user, like someone in the SQL editor. */
async function setStatus(id, status) {
  await db.query('UPDATE public.records SET status = $1 WHERE id = $2', [status, id]);
}

/** Adds a species as the postgres user. */
async function addSpecies(id, iucnCode = 'LC', sarawakProtected = false) {
  await db.query(
    `INSERT INTO public.species (id, scientific_name, family, iucn_code, sarawak_protected)
     VALUES ($1, $2, 'Testaceae', $3, $4)`,
    [id, `Testus ${id}`, iucnCode, sarawakProtected],
  );
}

async function roleOf(user) {
  const { rows } = await db.query('SELECT role FROM public.profiles WHERE id = $1', [user.id]);
  return rows[0].role;
}

/** The column names of a table or view, in order. */
async function columnsOf(table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

describe('roles and profiles', () => {
  test('researcher is a role now, and made up roles are still turned down', async () => {
    assert.equal(await roleOf(researcher), 'researcher');
    const user = await addUser(db, { name: 'New user' });
    await assert.rejects(
      db.query("UPDATE public.profiles SET role = 'ranger' WHERE id = $1", [user.id]),
      { code: '23514', constraint: 'profiles_role_check' },
    );
  });

  test('signing up always makes a visitor, whatever the sign up form sends', async () => {
    const id = randomUUID();
    await db.query('INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)', [
      id,
      `${id}@example.test`,
      JSON.stringify({ name: 'Keen user', role: 'admin' }),
    ]);
    const { rows } = await db.query('SELECT role FROM public.profiles WHERE id = $1', [id]);
    assert.equal(rows[0].role, 'visitor');
  });

  test('everyone reads their own profile, and only admins read everyone else', async () => {
    const sql = 'SELECT id FROM public.profiles ORDER BY id';
    for (const user of [visitor, researcher, botanist, officer]) {
      assert.deepEqual(await selectAs(db, user, sql), [{ id: user.id }], who(user));
    }
    const everyone = (await db.query(sql)).rows;
    assert.ok(everyone.length >= 6);
    assert.deepEqual(await selectAs(db, admin, sql), everyone);
    await assert.rejects(selectAs(db, null, sql), notAllowed);
  });

  test('admins change the roles of other users', async () => {
    const user = await addUser(db, { name: 'New botanist' });
    const sql = "UPDATE public.profiles SET role = 'botanist' WHERE id = $1";
    assert.equal(await changed(admin, sql, [user.id]), 1);
    assert.equal(await roleOf(user), 'botanist');
  });

  test("nobody else changes a role, and admins can't change their own", async () => {
    const sql = "UPDATE public.profiles SET role = 'admin' WHERE id = $1";
    for (const user of [visitor, researcher, botanist, officer]) {
      assert.equal(await changed(user, sql, [user.id]), 0, `${who(user)}, their own role`);
      assert.equal(await changed(user, sql, [otherBotanist.id]), 0, `${who(user)}, another role`);
    }
    const demote = "UPDATE public.profiles SET role = 'visitor' WHERE id = $1";
    assert.equal(await changed(admin, demote, [admin.id]), 0, 'an admin, their own role');
    await assert.rejects(run(null, sql, [visitor.id]), notAllowed);

    for (const user of [visitor, researcher, botanist, otherBotanist, officer, admin]) {
      assert.equal(await roleOf(user), user.role, who(user));
    }
  });

  test('nothing else in a profile can be changed through the API, even by an admin', async () => {
    const columns = {
      name: "'Someone else'",
      email: "'someone@example.test'",
      agency: "'Another agency'",
      avatar_url: "'https://example.test/me.jpg'",
      created_at: 'now()',
      updated_at: 'now()',
      id: "'00000000-0000-4000-8000-000000000000'",
    };
    for (const user of [visitor, botanist, officer, admin]) {
      for (const [column, value] of Object.entries(columns)) {
        const sql = `UPDATE public.profiles SET ${column} = ${value} WHERE id = $1`;
        await assert.rejects(
          run(user, sql, [otherBotanist.id]),
          notAllowed,
          `${who(user)}, ${column}`,
        );
      }
    }
    await assert.rejects(
      run(admin, 'INSERT INTO public.profiles (id, email, name) VALUES ($1, $2, $3)', [
        randomUUID(),
        'new@example.test',
        'New profile',
      ]),
      notAllowed,
    );
    await assert.rejects(
      run(admin, 'DELETE FROM public.profiles WHERE id = $1', [otherBotanist.id]),
      notAllowed,
    );
  });
});

describe('species', () => {
  const edit = "UPDATE public.species SET summary = 'Edited' WHERE id = $1";
  const remove = 'DELETE FROM public.species WHERE id = $1';

  function newSpecies() {
    return {
      id: `test-${randomUUID()}`,
      scientific_name: 'Testus plantus',
      family: 'Testaceae',
      iucn_code: 'LC',
    };
  }

  test('officers and admins add, edit and delete species', async () => {
    for (const user of [officer, admin]) {
      const species = newSpecies();
      const added = await insertAs(db, user, 'public.species', species);
      assert.equal(added.affectedRows, 1, who(user));

      assert.equal(await changed(user, edit, [species.id]), 1, who(user));
      const { rows } = await db.query('SELECT summary FROM public.species WHERE id = $1', [
        species.id,
      ]);
      assert.equal(rows[0].summary, 'Edited', who(user));

      assert.equal(await changed(user, remove, [species.id]), 1, who(user));
      const left = await db.query('SELECT id FROM public.species WHERE id = $1', [species.id]);
      assert.equal(left.rows.length, 0, who(user));
    }
  });

  test("other signed in users and people who aren't signed in can't change species", async () => {
    await addSpecies('test-locked');
    for (const user of [visitor, researcher, botanist]) {
      await assert.rejects(
        insertAs(db, user, 'public.species', newSpecies()),
        turnedDown,
        who(user),
      );
      assert.equal(await changed(user, edit, ['test-locked']), 0, who(user));
      assert.equal(await changed(user, remove, ['test-locked']), 0, who(user));
    }
    await assert.rejects(insertAs(db, null, 'public.species', newSpecies()), notAllowed);
    await assert.rejects(run(null, edit, ['test-locked']), notAllowed);
    await assert.rejects(run(null, remove, ['test-locked']), notAllowed);

    const { rows } = await db.query("SELECT summary FROM public.species WHERE id = 'test-locked'");
    assert.deepEqual(rows, [{ summary: null }]);
  });

  test('only officers and admins read the species table and species_staff', async () => {
    const everySpecies = (await db.query('SELECT id FROM public.species ORDER BY id')).rows;
    assert.ok(everySpecies.length >= 6);
    for (const table of ['public.species', 'public.species_staff']) {
      const sql = `SELECT id FROM ${table} ORDER BY id`;
      for (const user of [officer, admin]) {
        assert.deepEqual(await selectAs(db, user, sql), everySpecies, `${who(user)}, ${table}`);
      }
      for (const user of [visitor, researcher, botanist]) {
        assert.deepEqual(await selectAs(db, user, sql), [], `${who(user)}, ${table}`);
      }
      await assert.rejects(selectAs(db, null, sql), notAllowed, table);
    }
  });

  test('everyone reads species_public, which has no locations', async () => {
    const everySpecies = (await db.query('SELECT id FROM public.species ORDER BY id')).rows;
    const sql = 'SELECT id FROM public.species_public ORDER BY id';
    for (const user of [null, visitor, researcher, botanist, officer, admin]) {
      assert.deepEqual(await selectAs(db, user, sql), everySpecies, who(user));
    }
    assert.deepEqual(await columnsOf('species_public'), [
      'id',
      'slug',
      'scientific_name',
      'authority',
      'family',
      'common_names',
      'iucn_code',
      'sarawak_protected',
      'newer_name',
      'summary',
      'about',
      'description',
      'habitat',
      'uses',
      'updated_at',
      'rough_area_only',
    ]);
  });
});

describe('records', () => {
  const editNotes = "UPDATE public.records SET notes = 'Edited' WHERE id = $1";
  const remove = 'DELETE FROM public.records WHERE id = $1';

  test('officers and admins read every record, and field staff read their own', async () => {
    await upload(botanist);
    await upload(otherBotanist);
    const sql = 'SELECT id FROM public.records ORDER BY id';
    const everyRecord = (await db.query(sql)).rows;
    for (const user of [officer, admin]) {
      assert.deepEqual(await selectAs(db, user, sql), everyRecord, who(user));
    }
    for (const user of [botanist, otherBotanist]) {
      const { rows: theirOwn } = await db.query(
        'SELECT id FROM public.records WHERE submitted_by = $1 ORDER BY id',
        [user.id],
      );
      assert.ok(theirOwn.length > 0);
      assert.deepEqual(await selectAs(db, user, sql), theirOwn, who(user));
    }
    for (const user of [visitor, researcher]) {
      assert.deepEqual(await selectAs(db, user, sql), [], who(user));
    }
    await assert.rejects(selectAs(db, null, sql), notAllowed);
  });

  test('a botanist who becomes a visitor stops seeing and editing their records', async () => {
    const user = await addUser(db, { role: 'botanist', name: 'Former botanist' });
    const id = await upload(user);
    await db.query("UPDATE public.profiles SET role = 'visitor' WHERE id = $1", [user.id]);

    assert.deepEqual(await selectAs(db, user, 'SELECT id FROM public.records'), []);
    assert.equal(await changed(user, editNotes, [id]), 0);
    assert.equal((await storedRecord(id)).notes, everyField.row.notes);
  });

  test('a botanist can fix their own record while it waits for review', async () => {
    const id = await upload(botanist);
    const uploaded = await storedRecord(id);
    const newSpot = { lat: 3.8149, lng: 113.7799, accuracyM: 5 };
    const sql = `UPDATE public.records
      SET species_name = 'Unlisted species', species_slug = NULL, common_name = NULL,
          height_m = 3.5, condition = 'diseased', notes = 'Moved the tag to the other side.',
          gps = $2::jsonb, photo_count = 2, recorded_at = $3
      WHERE id = $1`;
    const changes = [id, JSON.stringify(newSpot), '2026-10-16T02:00:00.000Z'];
    assert.equal(await changed(botanist, sql, changes), 1);

    const saved = await storedRecord(id);
    assert.equal(saved.species_name, 'Unlisted species');
    assert.equal(saved.species_slug, null);
    assert.equal(saved.common_name, null);
    assert.equal(Number(saved.height_m), 3.5);
    assert.equal(saved.condition, 'diseased');
    assert.equal(saved.notes, 'Moved the tag to the other side.');
    assert.deepEqual(saved.gps, newSpot);
    assert.equal(saved.photo_count, 2);
    assert.equal(saved.recorded_at.toISOString(), '2026-10-16T02:00:00.000Z');

    // Still waiting for review, and still in the botanist's name.
    assert.equal(saved.status, 'waiting');
    assert.equal(saved.reviewed_by, null);
    assert.equal(saved.reviewed_at, null);
    assert.equal(saved.recorded_by, uploaded.recorded_by);
    assert.equal(saved.submitted_by, botanist.id);
    assert.equal(saved.tag_code, uploaded.tag_code);
  });

  test("a botanist can't edit someone else's record, or their own once it's reviewed", async () => {
    const someoneElses = await upload(otherBotanist);
    const published = await upload(botanist);
    await setStatus(published, 'published');
    const rejected = await upload(botanist);
    await setStatus(rejected, 'rejected');

    const records = { "someone else's": someoneElses, published, rejected };
    for (const [label, id] of Object.entries(records)) {
      assert.equal(await changed(botanist, editNotes, [id]), 0, label);
      assert.equal((await storedRecord(id)).notes, everyField.row.notes, label);
    }
  });

  test('only officers and admins review a record', async () => {
    const id = await upload(botanist);
    const reviews = [
      "UPDATE public.records SET status = 'published' WHERE id = $1",
      "UPDATE public.records SET status = 'rejected' WHERE id = $1",
      "UPDATE public.records SET review_notes = 'Looks right to me' WHERE id = $1",
    ];
    for (const sql of reviews) {
      await assert.rejects(
        run(botanist, sql, [id]),
        { code: '42501', message: /only officers and admins can review a record/ },
        sql,
      );
    }
    const saved = await storedRecord(id);
    assert.equal(saved.status, 'waiting');
    assert.equal(saved.review_notes, null);
  });

  test('the server fills in who reviewed a record and when', async () => {
    const review = 'UPDATE public.records SET status = $2, review_notes = $3 WHERE id = $1';

    const published = await upload(botanist);
    const changes = [published, 'published', 'Checked the photos.'];
    assert.equal(await changed(officer, review, changes), 1);
    let saved = await storedRecord(published);
    assert.equal(saved.status, 'published');
    assert.equal(saved.review_notes, 'Checked the photos.');
    assert.equal(saved.reviewed_by, officer.name);
    assert.ok(Math.abs(Date.now() - saved.reviewed_at.getTime()) < 60_000);

    const rejected = await upload(botanist);
    assert.equal(await changed(admin, review, [rejected, 'rejected', 'Wrong species.']), 1);
    saved = await storedRecord(rejected);
    assert.equal(saved.status, 'rejected');
    assert.equal(saved.reviewed_by, admin.name);

    // Changing something that isn't the review keeps the review as it was.
    const reviewedAt = saved.reviewed_at.getTime();
    const sql = 'UPDATE public.records SET height_m = 4 WHERE id = $1';
    assert.equal(await changed(officer, sql, [rejected]), 1);
    saved = await storedRecord(rejected);
    assert.equal(Number(saved.height_m), 4);
    assert.equal(saved.reviewed_by, admin.name);
    assert.equal(saved.reviewed_at.getTime(), reviewedAt);
  });

  test('officers and admins can reopen a decided record and decide again (item 19)', async () => {
    const decide = 'UPDATE public.records SET status = $2, review_notes = $3 WHERE id = $1';
    const reopen = "UPDATE public.records SET status = 'waiting' WHERE id = $1";

    // Rejected with a reason, sent back to the queue, then approved with the reason cleared
    const id = await upload(botanist);
    assert.equal(await changed(officer, decide, [id, 'rejected', 'The photo is blurry.']), 1);
    let saved = await storedRecord(id);
    assert.equal(saved.status, 'rejected');
    assert.equal(saved.review_notes, 'The photo is blurry.');
    assert.equal(saved.reviewed_by, officer.name);

    assert.equal(await changed(admin, reopen, [id]), 1);
    saved = await storedRecord(id);
    assert.equal(saved.status, 'waiting');
    // Reopening keeps the reason, and says the admin was the last to review it
    assert.equal(saved.review_notes, 'The photo is blurry.');
    assert.equal(saved.reviewed_by, admin.name);

    assert.equal(await changed(officer, decide, [id, 'published', null]), 1);
    saved = await storedRecord(id);
    assert.equal(saved.status, 'published');
    assert.equal(saved.review_notes, null);
    assert.equal(saved.reviewed_by, officer.name);

    // Published, sent back, so it leaves the public view until it's approved again
    const publicSql = 'SELECT id FROM public.records_public WHERE id = $1';
    assert.equal((await selectAs(db, null, publicSql, [id])).length, 1);
    assert.equal(await changed(officer, reopen, [id]), 1);
    assert.equal((await selectAs(db, null, publicSql, [id])).length, 0);

    // A botanist can't review a record, even their own. (Setting it to the status it already
    // has isn't a change, so that isn't tried.)
    for (const status of ['published', 'rejected']) {
      await assert.rejects(
        run(botanist, 'UPDATE public.records SET status = $2 WHERE id = $1', [id, status]),
        { code: '42501' },
        status,
      );
    }
  });

  test('a decision only applies to the record as it was when the page loaded (item 19)', async () => {
    // The website adds the status and the updated_at it saw to the WHERE, so a record that
    // someone else reviewed or edited in the meantime isn't changed
    const id = await upload(botanist);
    const loaded = (await storedRecord(id)).updated_at.toISOString();
    const decide = `UPDATE public.records SET status = 'published'
      WHERE id = $1 AND status = 'waiting' AND updated_at = $2`;

    // Someone edits it first, which moves updated_at
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await changed(officer, editNotes, [id]), 1);
    assert.equal(await changed(admin, decide, [id, loaded]), 0);
    assert.equal((await storedRecord(id)).status, 'waiting');

    // With the new updated_at it goes through, and a second decision on the same version doesn't
    const current = (await storedRecord(id)).updated_at.toISOString();
    assert.equal(await changed(admin, decide, [id, current]), 1);
    assert.equal(await changed(officer, decide, [id, current]), 0);
  });

  test('the SQL editor can still change a status, without a reviewer', async () => {
    const id = await upload(botanist);
    await setStatus(id, 'published');
    const saved = await storedRecord(id);
    assert.equal(saved.status, 'published');
    assert.equal(saved.reviewed_by, null);
  });

  test('nobody changes the review or upload details themselves', async () => {
    const id = await upload(botanist);
    const columns = {
      reviewed_by: "'Somebody else'",
      reviewed_at: 'now()',
      submitted_by: 'NULL',
      recorded_by: "'Somebody else'",
      uploaded_at: 'now()',
      id: "'00000000-0000-4000-8000-000000000000'",
      photo_urls: "'{}'",
    };
    for (const user of [botanist, officer, admin]) {
      for (const [column, value] of Object.entries(columns)) {
        const sql = `UPDATE public.records SET ${column} = ${value} WHERE id = $1`;
        await assert.rejects(run(user, sql, [id]), notAllowed, `${who(user)}, ${column}`);
      }
      const sql = "UPDATE public.records SET tag_code = 'NNP-000000' WHERE id = $1";
      await assert.rejects(run(user, sql, [id]), { code: '428C9' }, who(user));
    }
  });

  test("visitors, researchers and people who aren't signed in can't change records", async () => {
    const id = await upload(botanist);
    for (const user of [visitor, researcher]) {
      assert.equal(await changed(user, editNotes, [id]), 0, who(user));
      assert.equal(await changed(user, remove, [id]), 0, who(user));
    }
    await assert.rejects(run(null, editNotes, [id]), notAllowed);
    await assert.rejects(run(null, remove, [id]), notAllowed);
    assert.equal((await storedRecord(id)).notes, everyField.row.notes);
  });

  test('only officers and admins delete records', async () => {
    const own = await upload(botanist);
    assert.equal(await changed(botanist, remove, [own]), 0);
    assert.ok(await storedRecord(own));

    for (const user of [officer, admin]) {
      const id = await upload(botanist);
      assert.equal(await changed(user, remove, [id]), 1, who(user));
      assert.equal(await storedRecord(id), undefined, who(user));
    }
  });

  test('officers and admins edit a record in any status, and updated_at moves', async () => {
    const edit = `UPDATE public.records
      SET species_name = 'Edited species', height_m = 6.5, condition = 'damaged', notes = $2
      WHERE id = $1`;
    for (const status of ['waiting', 'published', 'rejected']) {
      for (const user of [officer, admin]) {
        const id = await upload(botanist);
        await setStatus(id, status);
        const before = await storedRecord(id);
        await new Promise((resolve) => setTimeout(resolve, 5));

        assert.equal(await changed(user, edit, [id, 'Fixed by staff']), 1, `${who(user)}, ${status}`);
        const saved = await storedRecord(id);
        assert.equal(saved.species_name, 'Edited species');
        assert.equal(Number(saved.height_m), 6.5);
        assert.equal(saved.notes, 'Fixed by staff');
        assert.ok(saved.updated_at > before.updated_at, `${who(user)}, ${status}`);
        // The status, the tag and who uploaded it stay as they were.
        assert.equal(saved.status, status);
        assert.equal(saved.tag_code, before.tag_code);
        assert.equal(saved.submitted_by, before.submitted_by);
        assert.equal(saved.uploaded_at.getTime(), before.uploaded_at.getTime());
      }
    }
  });

  test('saving a record with nothing different leaves updated_at alone', async () => {
    const id = await upload(botanist);
    const before = await storedRecord(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sql = 'UPDATE public.records SET notes = notes WHERE id = $1';
    assert.equal(await changed(officer, sql, [id]), 1);
    assert.equal((await storedRecord(id)).updated_at.getTime(), before.updated_at.getTime());
  });

  test('a record that was never edited has updated_at set when it was added', async () => {
    const id = await upload(botanist);
    const saved = await storedRecord(id);
    assert.ok(Math.abs(saved.updated_at.getTime() - saved.uploaded_at.getTime()) < 60_000);
    assert.ok(saved.updated_at > new Date('2026-01-01'));
  });

  test('records_staff shows updated_at, and the people who read records only', async () => {
    const id = await upload(botanist);
    const sql = 'SELECT updated_at FROM public.records_staff WHERE id = $1';
    for (const user of [officer, admin]) {
      const rows = await selectAs(db, user, sql, [id]);
      assert.equal(rows.length, 1, who(user));
      assert.ok(rows[0].updated_at instanceof Date, who(user));
    }
    assert.deepEqual(await selectAs(db, botanist, sql, [id]), []);
    assert.deepEqual(await selectAs(db, visitor, sql, [id]), []);
  });

  test('nobody sets updated_at themselves through the API', async () => {
    const id = await upload(botanist);
    const sql = 'UPDATE public.records SET updated_at = now() WHERE id = $1';
    for (const user of [botanist, officer, admin]) {
      await assert.rejects(run(user, sql, [id]), notAllowed, who(user));
    }
  });

  test('only officers and admins read records_staff, with the exact spots', async () => {
    const everyRecord = (await db.query('SELECT id, gps FROM public.records ORDER BY id')).rows;
    const sql = 'SELECT id, gps FROM public.records_staff ORDER BY id';
    for (const user of [officer, admin]) {
      assert.deepEqual(await selectAs(db, user, sql), everyRecord, who(user));
    }
    for (const user of [visitor, researcher, botanist]) {
      assert.deepEqual(await selectAs(db, user, sql), [], who(user));
    }
    await assert.rejects(selectAs(db, null, sql), notAllowed);
  });
});

describe('what the public sees in records_public', () => {
  const sql = 'SELECT gps FROM public.records_public WHERE id = $1';

  test('it leaves out the notes and the name of whoever recorded the plant', async () => {
    assert.deepEqual(await columnsOf('records_public'), [
      'id',
      'tag_code',
      'species_slug',
      'species_name',
      'common_name',
      'height_m',
      'condition',
      'photo_count',
      'recorded_at',
      'status',
      'gps',
    ]);
    const [belian] = await selectAs(db, null, 'SELECT * FROM public.records_public WHERE id = $1', [
      belianId,
    ]);
    assert.equal(belian.tag_code, 'NNP-3F2A9C');
    assert.equal(belian.species_name, 'Eusideroxylon zwageri');
    assert.equal(belian.common_name, 'Belian');
  });

  test('every seed record only shows its grid square, to everyone', async () => {
    for (const user of [null, visitor, researcher, botanist, officer, admin]) {
      const rows = await selectAs(db, user, 'SELECT id, gps FROM public.records_public');
      const shown = Object.fromEntries(
        rows.filter((row) => row.id in seedSquares).map((row) => [row.id, row.gps]),
      );
      assert.deepEqual(shown, seedSquares, who(user));
    }
  });

  test('only plants that are unprotected and LC or NT show their exact spot', async () => {
    const species = [
      ['LC', false, exactSpot],
      ['NT', false, exactSpot],
      ['LC', true, spotSquare],
      ['NT', true, spotSquare],
      ['VU', false, spotSquare],
      ['EN', false, spotSquare],
      ['CR', false, spotSquare],
      ['DD', false, spotSquare],
      ['NE', false, spotSquare],
    ];
    for (const [iucnCode, sarawakProtected, expected] of species) {
      const slug = `test-${iucnCode.toLowerCase()}${sarawakProtected ? '-protected' : ''}`;
      await addSpecies(slug, iucnCode, sarawakProtected);
      const id = await upload(botanist, {
        species_slug: slug,
        species_name: `Testus ${slug}`,
        common_name: null,
      });
      await setStatus(id, 'published');
      const [shown] = await selectAs(db, null, sql, [id]);
      assert.deepEqual(shown.gps, expected, slug);
    }
  });

  test("a species the species table doesn't have only shows its grid square", async () => {
    const id = await upload(botanist, {
      species_slug: null,
      species_name: 'Unlisted species',
      common_name: null,
    });
    await setStatus(id, 'published');
    const [shown] = await selectAs(db, null, sql, [id]);
    assert.deepEqual(shown.gps, spotSquare);
  });

  test('a record without a location stays without one', async () => {
    const id = await upload(botanist, { gps: null });
    await setStatus(id, 'published');
    const [shown] = await selectAs(db, null, sql, [id]);
    assert.equal(shown.gps, null);
  });

  test('records waiting for review or rejected stay off it, for everyone', async () => {
    const waiting = await upload(botanist);
    const rejected = await upload(botanist);
    await setStatus(rejected, 'rejected');
    const both = 'SELECT id FROM public.records_public WHERE id = $1 OR id = $2';
    for (const user of [null, visitor, researcher, botanist, officer, admin]) {
      assert.deepEqual(await selectAs(db, user, both, [waiting, rejected]), [], who(user));
    }
  });
});

describe('views', () => {
  test('the API can only read the views', async () => {
    const privileges = [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ];
    const expected = {
      anon: {
        species_public: ['SELECT'],
        records_public: ['SELECT'],
        species_staff: [],
        records_staff: [],
      },
      authenticated: {
        species_public: ['SELECT'],
        records_public: ['SELECT'],
        species_staff: ['SELECT'],
        records_staff: ['SELECT'],
      },
    };
    for (const [role, views] of Object.entries(expected)) {
      for (const [view, allowed] of Object.entries(views)) {
        const granted = [];
        for (const privilege of privileges) {
          const { rows } = await db.query('SELECT has_table_privilege($1, $2, $3) AS granted', [
            role,
            `public.${view}`,
            privilege,
          ]);
          if (rows[0].granted) granted.push(privilege);
        }
        assert.deepEqual(granted, allowed, `${role}, ${view}`);
      }
    }
  });

  test('writing through a view is turned down', async () => {
    const species = `(id, scientific_name, family, iucn_code)
      VALUES ('test-view', 'Testus plantus', 'Testaceae', 'LC')`;
    await assert.rejects(run(null, `INSERT INTO public.species_public ${species}`), notAllowed);
    await assert.rejects(
      run(botanist, "UPDATE public.species_public SET summary = 'Edited'"),
      notAllowed,
    );
    await assert.rejects(run(botanist, `INSERT INTO public.species_staff ${species}`), notAllowed);
    const { rows } = await db.query("SELECT id FROM public.species WHERE id = 'test-view'");
    assert.deepEqual(rows, []);
  });

  test('the staff views read as whoever asks, and records_public filters first', async () => {
    const { rows } = await db.query(
      `SELECT relname, reloptions FROM pg_class
       WHERE oid IN ('public.species_staff'::regclass, 'public.records_staff'::regclass,
         'public.records_public'::regclass)`,
    );
    const options = Object.fromEntries(rows.map((row) => [row.relname, row.reloptions]));
    assert.ok(options.species_staff.includes('security_invoker=true'));
    assert.ok(options.records_staff.includes('security_invoker=true'));
    assert.ok(options.records_public.includes('security_barrier=true'));
  });

  test('the observations view is gone, and nobody can run the review trigger', async () => {
    const { rows } = await db.query(
      `SELECT to_regclass('public.observations') AS observations,
         has_function_privilege('anon', 'public.fill_in_review()', 'EXECUTE') AS anon,
         has_function_privilege('authenticated', 'public.fill_in_review()', 'EXECUTE')
           AS authenticated`,
    );
    assert.deepEqual(rows[0], { observations: null, anon: false, authenticated: false });
  });
});

describe('part way through the SQL files', () => {
  // The files go on the hosted project one at a time, so every stopping point has to be safe on
  // its own, not just the end. This checks each one from 003 on.
  const publicViews = ['records_public', 'species_photos_public', 'species_public'];

  test('after each file, the API can only read the views, and anon only the public ones', async () => {
    for (let n = SQL_FILES.indexOf('003_profiles_read_own.sql') + 1; n <= SQL_FILES.length; n++) {
      const files = SQL_FILES.slice(0, n);
      const partWay = await newDatabase(files);
      try {
        const { rows: writable } = await partWay.query(
          `SELECT c.relname AS view, r.role, p.privilege
           FROM pg_class AS c
           CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
           CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(privilege)
           WHERE c.relnamespace = 'public'::regnamespace
             AND c.relkind = 'v'
             AND has_table_privilege(r.role, c.oid, p.privilege)
           ORDER BY 1, 2, 3`,
        );
        assert.deepEqual(writable, [], `after ${files.at(-1)}`);

        const { rows: readable } = await partWay.query(
          `SELECT c.relname AS view
           FROM pg_class AS c
           WHERE c.relnamespace = 'public'::regnamespace
             AND c.relkind = 'v'
             AND has_table_privilege('anon', c.oid, 'SELECT')
           ORDER BY 1`,
        );
        for (const { view } of readable) {
          assert.ok(publicViews.includes(view), `anon reads ${view} after ${files.at(-1)}`);
        }
      } finally {
        await partWay.close();
      }
    }
  });

  test('records_public never has the notes or who recorded a plant, from 004 on', async () => {
    for (let n = SQL_FILES.indexOf('004_security_hardening.sql') + 1; n <= SQL_FILES.length; n++) {
      const files = SQL_FILES.slice(0, n);
      const partWay = await newDatabase(files);
      try {
        const { rows } = await partWay.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'records_public'`,
        );
        const columns = rows.map((row) => row.column_name);
        assert.ok(!columns.includes('notes'), `after ${files.at(-1)}`);
        assert.ok(!columns.includes('recorded_by'), `after ${files.at(-1)}`);
      } finally {
        await partWay.close();
      }
    }
  });
});

describe('sensor nodes', () => {
  const sql = 'SELECT node_id FROM public.iot_nodes ORDER BY node_id';
  const node = { node_id: 'NNP-IOT-TEST', name: 'Test node', zone: 'Test zone' };
  const edit = "UPDATE public.iot_nodes SET status = 'offline' WHERE node_id = $1";
  const remove = 'DELETE FROM public.iot_nodes WHERE node_id = $1';

  test('only officers and admins see the sensor nodes', async () => {
    const seedNodes = [
      { node_id: 'NNP-IOT-01' },
      { node_id: 'NNP-IOT-02' },
      { node_id: 'NNP-IOT-03' },
    ];
    for (const user of [officer, admin]) {
      assert.deepEqual(await selectAs(db, user, sql), seedNodes, who(user));
    }
    for (const user of [visitor, researcher, botanist]) {
      assert.deepEqual(await selectAs(db, user, sql), [], who(user));
    }
    await assert.rejects(selectAs(db, null, sql), notAllowed);
  });

  test('only admins add, change or remove a node', async () => {
    for (const user of [visitor, researcher, botanist, officer]) {
      await assert.rejects(insertAs(db, user, 'public.iot_nodes', node), turnedDown, who(user));
      assert.equal(await changed(user, edit, ['NNP-IOT-01']), 0, who(user));
      assert.equal(await changed(user, remove, ['NNP-IOT-01']), 0, who(user));
    }
    await assert.rejects(insertAs(db, null, 'public.iot_nodes', node), notAllowed);
    await assert.rejects(run(null, edit, ['NNP-IOT-01']), notAllowed);
    await assert.rejects(run(null, remove, ['NNP-IOT-01']), notAllowed);
    const seed = await db.query("SELECT status FROM public.iot_nodes WHERE node_id = 'NNP-IOT-01'");
    assert.deepEqual(seed.rows, [{ status: 'online' }]);

    assert.equal((await insertAs(db, admin, 'public.iot_nodes', node)).affectedRows, 1);
    assert.equal(await changed(admin, edit, [node.node_id]), 1);
    assert.equal(await changed(admin, remove, [node.node_id]), 1);
    const left = await db.query('SELECT node_id FROM public.iot_nodes WHERE node_id = $1', [
      node.node_id,
    ]);
    assert.deepEqual(left.rows, []);
  });
});

describe('species photos in Storage', () => {
  const rename = `UPDATE storage.objects SET name = $2
    WHERE bucket_id = 'botanical-photos' AND name = $1`;
  const remove = "DELETE FROM storage.objects WHERE bucket_id = 'botanical-photos' AND name = $1";

  function speciesPhoto() {
    return `eusideroxylon-zwageri/${randomUUID()}.jpg`;
  }

  function uploadPhoto(user, name, bucket = 'botanical-photos') {
    return insertAs(db, user, 'storage.objects', {
      bucket_id: bucket,
      name,
      owner: user?.id ?? null,
    });
  }

  test('the bucket stays public and takes the same images as record-photos', async () => {
    const { rows } = await db.query(
      `SELECT public, file_size_limit, allowed_mime_types
       FROM storage.buckets
       WHERE id = 'botanical-photos'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public, true);
    assert.equal(Number(rows[0].file_size_limit), 10 * 1024 * 1024);
    assert.deepEqual(rows[0].allowed_mime_types, [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
    ]);
  });

  test('officers and admins add, replace and delete species photos', async () => {
    for (const user of [officer, admin]) {
      const name = speciesPhoto();
      const newName = speciesPhoto();
      assert.equal((await uploadPhoto(user, name)).affectedRows, 1, who(user));
      assert.equal(await changed(user, rename, [name, newName]), 1, who(user));
      assert.equal(await changed(user, remove, [newName]), 1, who(user));
    }
  });

  test('nobody else adds, replaces or deletes them', async () => {
    const name = speciesPhoto();
    await uploadPhoto(officer, name);
    for (const user of [null, visitor, researcher, botanist]) {
      await assert.rejects(uploadPhoto(user, speciesPhoto()), turnedDown, who(user));
      assert.equal(await changed(user, rename, [name, speciesPhoto()]), 0, who(user));
      assert.equal(await changed(user, remove, [name]), 0, who(user));
    }
    const { rows } = await db.query('SELECT name FROM storage.objects WHERE name = $1', [name]);
    assert.equal(rows.length, 1);
  });

  test("the species photo rules don't reach the private record-photos bucket", async () => {
    const move = 'UPDATE storage.objects SET bucket_id = $2 WHERE bucket_id = $3 AND name = $1';
    const recordPhoto = `${botanist.id}/${randomUUID()}/1.jpg`;
    await uploadPhoto(botanist, recordPhoto, 'record-photos');
    for (const user of [botanist, officer, admin]) {
      const changes = [recordPhoto, 'botanical-photos', 'record-photos'];
      assert.equal(await changed(user, move, changes), 0, `${who(user)}, moving it`);
    }
    // 009 lets officers and admins delete record photos (photos.test.js), but not add them
    for (const user of [officer, admin]) {
      const intoSomeoneElses = `${botanist.id}/${randomUUID()}/1.jpg`;
      await assert.rejects(
        uploadPhoto(user, intoSomeoneElses, 'record-photos'),
        turnedDown,
        who(user),
      );
    }
    const { rows } = await db.query('SELECT bucket_id FROM storage.objects WHERE name = $1', [
      recordPhoto,
    ]);
    assert.deepEqual(rows, [{ bucket_id: 'record-photos' }]);

    const name = speciesPhoto();
    await uploadPhoto(officer, name);
    await assert.rejects(
      run(officer, move, [name, 'record-photos', 'botanical-photos']),
      turnedDown,
    );
  });

  test('anyone can see species photos, because the plant pages show them', async () => {
    const name = speciesPhoto();
    await uploadPhoto(officer, name);
    for (const user of [null, visitor]) {
      const rows = await selectAs(db, user, 'SELECT name FROM storage.objects WHERE name = $1', [
        name,
      ]);
      assert.equal(rows.length, 1, who(user));
    }
  });
});

// Through the API, an update or a delete can come without a filter. A change that doesn't read
// the table (no WHERE or RETURNING) skips the read rules and only meets the update or delete
// rules, so these tests check that those rules hold by themselves.
describe('changes with no filter', () => {
  test('nobody but an admin changes a role', async () => {
    const sql = "UPDATE public.profiles SET role = 'admin'";
    for (const user of [visitor, researcher, botanist, officer]) {
      assert.equal(await changed(user, sql), 0, who(user));
    }
    await assert.rejects(run(null, sql), notAllowed);
    for (const user of [visitor, researcher, botanist, otherBotanist, officer, admin]) {
      assert.equal(await roleOf(user), user.role, who(user));
    }
  });

  test('a botanist only fixes their own records that are still waiting', async () => {
    const user = await addUser(db, { role: 'botanist', name: 'Third botanist' });
    const waiting = await upload(user);
    const published = await upload(user);
    await setStatus(published, 'published');
    const someoneElses = await upload(otherBotanist);
    const sql = "UPDATE public.records SET notes = 'Fixed with no filter'";
    assert.equal(await changed(user, sql), 1);
    assert.equal((await storedRecord(waiting)).notes, 'Fixed with no filter');
    for (const id of [published, someoneElses]) {
      assert.equal((await storedRecord(id)).notes, everyField.row.notes, id);
    }
  });

  test("visitors, researchers and former botanists don't change any record", async () => {
    const former = await addUser(db, { role: 'botanist', name: 'Another former botanist' });
    const id = await upload(former);
    await db.query("UPDATE public.profiles SET role = 'visitor' WHERE id = $1", [former.id]);
    const sql = "UPDATE public.records SET notes = 'Changed with no filter'";
    for (const user of [visitor, researcher, former]) {
      assert.equal(await changed(user, sql), 0, who(user));
    }
    await assert.rejects(run(null, sql), notAllowed);
    assert.equal((await storedRecord(id)).notes, everyField.row.notes);
  });

  test("visitors, researchers and botanists don't delete any record", async () => {
    const sql = 'DELETE FROM public.records';
    for (const user of [visitor, researcher, botanist]) {
      assert.equal(await changed(user, sql), 0, who(user));
    }
    await assert.rejects(run(null, sql), notAllowed);
  });

  test('species, sensor nodes and species photos stay as they are', async () => {
    const statements = [
      "UPDATE public.species SET summary = 'Changed with no filter'",
      'DELETE FROM public.species',
      "UPDATE public.iot_nodes SET status = 'offline'",
      'DELETE FROM public.iot_nodes',
      "UPDATE storage.objects SET name = 'changed-with-no-filter.jpg'",
      'DELETE FROM storage.objects',
    ];
    // Every table has rows here, so a 0 below means the rules held.
    for (const table of ['public.species', 'public.iot_nodes', 'storage.objects']) {
      const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table}`);
      assert.ok(rows[0].count > 0, table);
    }
    for (const user of [visitor, researcher, botanist]) {
      for (const sql of statements) {
        assert.equal(await changed(user, sql), 0, `${who(user)}, ${sql}`);
      }
    }
    // Officers read the sensor nodes, but only admins change them.
    for (const sql of statements.filter((statement) => statement.includes('iot_nodes'))) {
      assert.equal(await changed(officer, sql), 0, sql);
    }
  });
});

describe('running 006, 007 and 008 again', () => {
  /** Everything 006, 007 and 008 set up, read from the Postgres catalogs. */
  async function catalogs() {
    const queries = [
      `SELECT schemaname, tablename, policyname, cmd, roles::text[] AS roles, qual, with_check
       FROM pg_policies
       ORDER BY schemaname, tablename, policyname`,
      `SELECT n.nspname, c.relname, c.relkind::text AS kind, c.relrowsecurity, c.reloptions,
         ARRAY(SELECT acl::text FROM unnest(c.relacl) AS acl ORDER BY 1) AS acl
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'storage') AND c.relkind IN ('r', 'v')
       ORDER BY n.nspname, c.relname`,
      `SELECT c.relname, a.attname,
         ARRAY(SELECT acl::text FROM unnest(a.attacl) AS acl ORDER BY 1) AS acl
       FROM pg_attribute AS a
       JOIN pg_class AS c ON c.oid = a.attrelid
       WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
       ORDER BY c.relname, a.attname`,
      `SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
      `SELECT p.oid::regprocedure::text AS function, p.prosecdef, p.proconfig, p.prosrc,
         p.proacl IS NULL AS default_acl,
         ARRAY(SELECT acl::text FROM unnest(p.proacl) AS acl ORDER BY 1) AS acl
       FROM pg_proc AS p
       WHERE p.pronamespace = 'public'::regnamespace
       ORDER BY 1`,
      `SELECT tgrelid::regclass::text AS table_name, tgname, tgfoid::regprocedure::text AS function,
         tgtype, tgenabled::text AS enabled
       FROM pg_trigger
       WHERE NOT tgisinternal
       ORDER BY 1, 2`,
      `SELECT conrelid::regclass::text AS table_name, conname,
         pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
       ORDER BY 1, 2`,
      `SELECT id, name, public, file_size_limit, allowed_mime_types
       FROM storage.buckets
       ORDER BY id`,
    ];
    const results = [];
    for (const query of queries) {
      results.push((await db.query(query)).rows);
    }
    return results;
  }

  test('ends up the same as the first time', async () => {
    const firstTime = await catalogs();
    // 006 makes records_public, species_staff and records_staff again without what 007, 008 and
    // 019 add to them, and its REVOKE on iot_nodes takes the column grants 016_2 adds, so they
    // have to run again after it (see supabase/README.md).
    await db.exec(readSql('006_role_based_access.sql'));
    await db.exec(readSql('007_species_fixes.sql'));
    await db.exec(readSql('008_record_edits.sql'));
    await db.exec(readSql('016_2_iot_nodes.sql'));
    await db.exec(readSql('019_public_record_details.sql'));
    assert.deepEqual(await catalogs(), firstTime);

    const sql = 'SELECT gps FROM public.records_public WHERE id = $1';
    const [belian] = await selectAs(db, null, sql, [belianId]);
    assert.deepEqual(belian.gps, seedSquares[belianId]);
  });

  test('a plant marked rough area only stays hidden after 006, before 007 runs again', async () => {
    await addSpecies('test-rough-again');
    await db.query("UPDATE public.species SET rough_area_only = true WHERE id = 'test-rough-again'");
    const id = await upload(botanist, {
      species_slug: 'test-rough-again',
      species_name: 'Testus test-rough-again',
      common_name: null,
    });
    await setStatus(id, 'published');
    const sql = 'SELECT gps FROM public.records_public WHERE id = $1';
    try {
      await db.exec(readSql('006_role_based_access.sql'));
      const [shown] = await selectAs(db, null, sql, [id]);
      assert.deepEqual(shown.gps, spotSquare);
    } finally {
      await db.exec(readSql('007_species_fixes.sql'));
      await db.exec(readSql('008_record_edits.sql'));
      await db.exec(readSql('016_2_iot_nodes.sql'));
      await db.exec(readSql('019_public_record_details.sql'));
    }
  });
});
