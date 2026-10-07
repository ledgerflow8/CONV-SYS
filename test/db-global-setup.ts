// Makes sure the test database exists and has every migration applied (non-destructive).
// Each test empties the tables itself (test/fixtures.ts resetDb). Only touches DBs named *_test.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/va_portal_test";
  const parsed = new URL(url);
  const name = parsed.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`Refusing to use "${name}": test DB name must end in _test`);

  // Create it if missing, via the server's maintenance database.
  parsed.pathname = "/postgres";
  const admin = new PrismaClient({ datasourceUrl: parsed.toString() });
  try {
    const exists = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (exists.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
}
