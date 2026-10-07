// Database tests (*.db.test.ts) against a throwaway Postgres DB: npm run test:db
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54329/va_portal_test";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["./test/db-global-setup.ts"],
    env: {
      DATABASE_URL: TEST_DB,
      DIRECT_URL: TEST_DB,
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", // test-only key
    },
    fileParallelism: false, // files share one database
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
