#!/usr/bin/env node
//
// Forward-only migration runner.
//
// Applies db/NNN_*.sql in filename order, once each, inside a transaction.
// Records a checksum of every applied file and refuses to run if one of them
// has changed since it was applied, because an edited migration means the
// database you are looking at and the database CI builds are different objects.

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// DDL through a transaction pooler is unreliable, so migrations take the
// direct connection when one is available.
const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "No database URL. Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL.\n" +
      "Local runs read .env.local via: node --env-file=.env.local db/migrate.mjs",
  );
  process.exit(1);
}

const checksum = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function main() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(here)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

    if (files.length === 0) {
      console.log("No migrations found.");
      return;
    }

    const { rows } = await client.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    let ran = 0;

    for (const file of files) {
      const sql = await readFile(join(here, file), "utf8");
      const sum = checksum(sql);
      const seen = applied.get(file);

      if (seen !== undefined) {
        if (seen !== sum) {
          throw new Error(
            `${file} was applied on ${new Date().toISOString().slice(0, 10)} with checksum ${seen} ` +
              `but now hashes to ${sum}. Migrations are forward only. ` +
              `Revert the edit and add a new numbered migration instead.`,
          );
        }
        continue;
      }

      process.stdout.write(`applying ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          file,
          sum,
        ]);
        await client.query("COMMIT");
        console.log("ok");
        ran += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file} failed and was rolled back: ${err.message}`);
      }
    }

    console.log(
      ran === 0
        ? `Up to date. ${files.length} migration(s) already applied.`
        : `Applied ${ran} migration(s). ${files.length} total.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nmigration failed: ${err.message}`);
  process.exit(1);
});
