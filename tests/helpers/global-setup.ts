import { execSync } from "node:child_process";

// Applies migrations to TEST_DATABASE_URL before DB tests. Without it, DB tests are skipped.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url }, stdio: "pipe" });
}
