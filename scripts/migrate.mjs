import { readFile } from "node:fs/promises";
import pg from "pg";

try {
  process.loadEnvFile();
} catch {
}

const sql = await readFile(new URL("../database/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log("Schema aplicado.");
} finally {
  await client.end();
}
