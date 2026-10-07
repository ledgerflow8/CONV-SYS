// Dev seed: 1 Director, 2 LMs, 4 Lead VAs, 12 VAs, 2 models, 30 TG accounts.
// Refuses to touch a DB that already has users unless run with --reset.
// All seed users share SEED_PASSWORD so you can log in as any role.
import { PrismaClient, Role, TgStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { SETTING_DEFAULTS } from "../src/lib/settings-defaults";

const db = new PrismaClient();
const SEED_PASSWORD = "password123";
const RESET = process.argv.includes("--reset");

function slug() {
  return randomBytes(4).toString("base64url").slice(0, 6).toLowerCase();
}

async function wipe() {
  // Child tables first.
  await db.auditLog.deleteMany();
  await db.payout.deleteMany();
  await db.convo.deleteMany();
  await db.linkClick.deleteMany();
  await db.trackingLink.deleteMany();
  await db.tgAssignment.deleteMany();
  await db.inviteToken.deleteMany();
  await db.tgAccount.deleteMany();
  await db.week.deleteMany();
  await db.resource.deleteMany();
  await db.setting.deleteMany();
  await db.user.updateMany({ data: { parentId: null, createdById: null } });
  await db.user.deleteMany();
  await db.model.deleteMany();
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production.");

  const existing = await db.user.count();
  if (existing > 0 && !RESET) {
    throw new Error(`DB already has ${existing} users. Re-run with --reset to wipe and reseed.`);
  }
  if (RESET) await wipe();

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  await db.setting.createMany({
    data: Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value })),
  });

  const models = await Promise.all(
    ["Sophie", "Mia"].map((name) => db.model.create({ data: { name } })),
  );

  // 15 accounts per model.
  for (const [mi, model] of models.entries()) {
    for (let i = 1; i <= 15; i++) {
      const username = `${model.name.toLowerCase()}_tg${String(i).padStart(2, "0")}`;
      await db.tgAccount.create({
        data: {
          modelId: model.id,
          username,
          phone: `+1555${mi}${String(100000 + i).slice(1)}`,
          link: `https://t.me/${username}`,
        },
      });
    }
  }

  const director = await db.user.create({
    data: { username: "director", passwordHash, role: Role.DIRECTOR },
  });

  const lms = [];
  for (const name of ["alpha", "bravo"]) {
    lms.push(
      await db.user.create({
        data: {
          username: `${name}_LM`,
          passwordHash,
          role: Role.LEAD_MANAGER,
          parentId: director.id,
          createdById: director.id,
          telegramHandle: `${name}_lm`,
        },
      }),
    );
  }

  // 2 Lead VAs per LM; each LM gets one team per model.
  let vaN = 0;
  for (const [li, lm] of lms.entries()) {
    for (const model of models) {
      const handle = `team${li + 1}${model.name.toLowerCase()}`;
      const leadVa = await db.user.create({
        data: {
          username: `${handle}_LVA`,
          passwordHash,
          role: Role.LEAD_VA,
          parentId: lm.id,
          createdById: lm.id,
          modelId: model.id,
          telegramHandle: handle,
        },
      });

      // 3 VAs per Lead VA, each holding one account from the team's model.
      for (let v = 0; v < 3; v++) {
        vaN++;
        const vaHandle = `va${String(vaN).padStart(2, "0")}_${model.name.toLowerCase()}`;
        const va = await db.user.create({
          data: {
            username: vaHandle,
            passwordHash,
            role: Role.VA,
            parentId: leadVa.id,
            createdById: leadVa.id,
            modelId: model.id,
            telegramHandle: vaHandle,
            walletAddress: vaN % 4 === 0 ? null : `0x${randomBytes(20).toString("hex")}`,
          },
        });

        const account = await db.tgAccount.findFirstOrThrow({
          where: { modelId: model.id, status: TgStatus.AVAILABLE },
          orderBy: { username: "asc" },
        });
        await db.tgAccount.update({
          where: { id: account.id },
          data: { status: TgStatus.ASSIGNED, vaId: va.id },
        });
        await db.tgAssignment.create({ data: { tgAccountId: account.id, vaId: va.id } });
        await db.trackingLink.create({ data: { vaId: va.id, slug: slug() } });
      }
    }
  }

  const counts = {
    users: await db.user.groupBy({ by: ["role"], _count: true }),
    models: await db.model.count(),
    tgAccounts: await db.tgAccount.groupBy({ by: ["status"], _count: true }),
    trackingLinks: await db.trackingLink.count(),
  };
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Seeded. Log in as any user with password "${SEED_PASSWORD}" (e.g. director, alpha_LM, team1sophie_LVA, va01_sophie).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
