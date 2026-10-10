// Launch: delete ALL data except Settings (Tier 1, rates, timezone…) and the CapitalAI sync state.
// Removes users, models, Telegram accounts, convos, clicks, weeks, payouts, resources, every file
// in the Storage bucket, and the audit log. Irreversible.
//
//   npx tsx scripts/wipe-demo.ts                      # dry run: shows what would be deleted
//   npx tsx scripts/wipe-demo.ts --yes-delete-everything
import { db } from "../src/lib/db";
import { storage } from "../src/lib/storage";

// One at a time: production allows a single pooled connection.
async function counts() {
  return {
    users: await db.user.count(),
    models: await db.model.count(),
    accounts: await db.tgAccount.count(),
    convos: await db.convo.count(),
    clicks: await db.linkClick.count(),
    weeks: await db.week.count(),
    payouts: await db.payout.count(),
    resources: await db.resource.count(),
    audit: await db.auditLog.count(),
  };
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgresql://x@unset/x").hostname;
  console.log(`Database: ${host}`);
  console.log("Current:", await counts());
  // Every file goes: all resources are being deleted, and this also catches orphaned uploads.
  const files = await storage().listAll();
  console.log(`Files in Storage bucket: ${files.length}${files.length ? ` (${files.slice(0, 5).map((f) => f.split("/").pop()).join(", ")}${files.length > 5 ? ", …" : ""})` : ""}`);

  if (!process.argv.includes("--yes-delete-everything")) {
    console.log("\nDry run. Nothing deleted. Re-run with --yes-delete-everything to wipe.");
    return;
  }

  await db.$transaction(async (tx) => {
    // Children first.
    await tx.payout.deleteMany();
    await tx.convo.deleteMany();
    await tx.linkClick.deleteMany();
    await tx.trackingLink.deleteMany();
    await tx.tgAssignment.deleteMany();
    await tx.inviteToken.deleteMany();
    await tx.tgAccount.deleteMany();
    await tx.week.deleteMany();
    await tx.resource.deleteMany();
    await tx.auditLog.deleteMany();
    await tx.user.updateMany({ data: { parentId: null, createdById: null } });
    await tx.user.deleteMany();
    await tx.model.deleteMany();
  });

  // Files after the rows are gone: a failure leaves orphaned files, never rows pointing at nothing.
  if (files.length) {
    await storage()
      .remove(files)
      .then(() => console.log(`Deleted ${files.length} file(s) from Storage.`))
      .catch((e) => console.log(`Storage cleanup failed (rows are gone; files can be removed in Supabase): ${e.message}`));
  }

  console.log("After:", await counts());
  console.log("Settings kept:", (await db.setting.findMany({ select: { key: true } })).map((s) => s.key).join(", "));
  console.log("\nDone. Next: npx tsx scripts/create-director.ts <username>");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
