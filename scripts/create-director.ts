// Creates THE Director account on a fresh (production) database. Run it yourself, in your own
// terminal, so the password is only ever shown to you:
//
//   DATABASE_URL="<production direct URL>" npx tsx scripts/create-director.ts <username>
//
// Refuses if a Director already exists. The password is generated, printed once, and stored hashed.
import { PrismaClient } from "@prisma/client";
import { generatePassword, hashPassword } from "../src/lib/auth/password";

async function main() {
  const username = process.argv[2]?.trim();
  if (!username || !/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(username)) {
    throw new Error("Usage: npx tsx scripts/create-director.ts <username>  (3–32 letters, numbers or underscores)");
  }
  const db = new PrismaClient();
  try {
    if (await db.user.findFirst({ where: { role: "DIRECTOR" } })) throw new Error("A Director already exists. Nothing changed.");
    const password = generatePassword(16);
    await db.user.create({ data: { username, passwordHash: await hashPassword(password), role: "DIRECTOR" } });
    await db.auditLog.create({ data: { action: "user.create", meta: { username, role: "DIRECTOR", via: "create-director script" } } });
    console.log(`\nDirector created.\n  Username: ${username}\n  Password: ${password}\n\nSave it now: it isn't stored anywhere in readable form and won't be shown again.\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
