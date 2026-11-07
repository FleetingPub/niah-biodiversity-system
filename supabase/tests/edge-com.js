// Runs our edge-com Edge Function (supabase/functions/edge-com/index.ts) here in Node, on a PGlite
// database from harness.js, so the stand-in and the tests use the same code that's deployed, not a
// copy of it. Supabase runs it in Deno. The only parts of Deno it uses are Deno.env.get and
// Deno.serve, so this gives it those two. It takes out the TypeScript types with Node's own
// stripTypeScriptTypes, which came in Node 22.13.
//
// On Supabase it reaches the database with the postgres package (postgres.js) through
// SUPABASE_DB_URL, as the postgres user, so Row Level Security doesn't apply to it. Here its
// import is swapped for postgresOnPglite below, which does the few parts of postgres.js it uses
// on the PGlite database, also as the postgres user. That keeps this to the packages we already
// have.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { gzipSync } from 'node:zlib';

const SOURCE = new URL('../functions/edge-com/index.ts', import.meta.url);
const POSTGRES_IMPORT = 'import postgres from "npm:postgres@3.4.9";';

/** Whether this Node can run edge-com. */
export const EDGE_COM_RUNS = typeof nodeModule.stripTypeScriptTypes === 'function';

// Each copy of edge-com gets its own Deno, console and database, under its own name, so two
// stand-ins in one test run don't share one
let copies = 0;

/** A piece of SQL from a helper call like sql(columns), with its own values. */
class Fragment {
  constructor(build) {
    this.build = build;
  }
}

const quoteName = (name) => {
  assert.match(name, /^[a-z_][a-z0-9_]*$/, `edge-com asked for a column called ${name}`);
  return `"${name}"`;
};

/**
 * The parts of postgres.js that edge-com uses, run on a PGlite database or transaction:
 * sql`... ${value} ...` for a query with its values as $1 style parameters, giving back the rows;
 * sql(['a', 'b']) for a list of column names; sql(row, ...columns) and sql(rows, ...columns) for
 * the "(columns) values (...)" of an insert; sql.begin(fn) for a transaction; and sql.end().
 */
function postgresOnPglite(db) {
  const make = (runner) => {
    const sql = (first, ...rest) => {
      // A tagged template: the query itself
      if (Array.isArray(first) && Object.hasOwn(first, 'raw')) {
        const params = [];
        let text = first[0];
        rest.forEach((value, i) => {
          text += value instanceof Fragment ? value.build(params) : `$${params.push(value)}`;
          text += first[i + 1];
        });
        return runner.query(text, params).then((result) => result.rows);
      }
      // A list of column names
      if (Array.isArray(first) && rest.length === 0) {
        return new Fragment(() => first.map(quoteName).join(', '));
      }
      // One row or a list of rows to insert, with the columns to take from them
      const rows = Array.isArray(first) ? first : [first];
      const columns = rest.flat();
      return new Fragment(
        (params) =>
          `(${columns.map(quoteName).join(', ')}) values ` +
          rows
            .map((row) => `(${columns.map((column) => `$${params.push(row[column] ?? null)}`).join(', ')})`)
            .join(', '),
      );
    };
    return sql;
  };
  const sql = make(db);
  sql.begin = (fn) => db.transaction((tx) => fn(make(tx)));
  sql.end = async () => {};
  return sql;
}

/**
 * Starts edge-com on a database. handle(request) gives a Request to it the way Supabase does and
 * gives back its Response. upload(key, batch) sends a batch the way cloud-com.py on an edge does:
 * gzip-compressed JSON with the device's token in x-edge-key. What edge-com logs goes to output,
 * which has log, warn and error like console.
 */
export async function startEdgeCom(db, { output = console } = {}) {
  if (!EDGE_COM_RUNS) throw new Error('Running edge-com here needs Node 22.13 or newer');

  const source = readFileSync(SOURCE, 'utf8');
  copies += 1;
  const name = `__edgeCom${copies}`;
  // A module's own postgres, Deno and console come before the global ones
  const swapped = source.replace(
    POSTGRES_IMPORT,
    `const { postgres, Deno, console } = globalThis[${JSON.stringify(name)}];`,
  );
  assert.notEqual(swapped, source, 'edge-com no longer imports postgres the way we expect');

  let handler = null;
  globalThis[name] = {
    postgres: () => postgresOnPglite(db),
    Deno: {
      // edge-com only checks that this is set. The database is the one given above.
      env: { get: (key) => (key === 'SUPABASE_DB_URL' ? 'pglite://harness' : undefined) },
      serve: (fn) => {
        handler = fn;
      },
    },
    console: output,
  };
  const code = nodeModule.stripTypeScriptTypes(swapped);
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(typeof handler, 'function', 'edge-com no longer calls Deno.serve the way we expect');

  return {
    handle: (request) => handler(request),
    upload(key, batch, { gzip = true } = {}) {
      const json = JSON.stringify(batch);
      const headers = { 'Content-Type': 'application/json', 'x-edge-key': key };
      if (gzip) headers['Content-Encoding'] = 'gzip';
      return handler(
        new Request('http://edge-com.test/functions/v1/edge-com', {
          method: 'POST',
          headers,
          body: gzip ? gzipSync(json) : json,
        }),
      );
    },
    // Nothing to close: it has no connections of its own. Kept so the callers stay the same
    // if it ever does.
    async close() {
      delete globalThis[name];
    },
  };
}
