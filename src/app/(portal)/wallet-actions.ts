"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireUser } from "@/lib/auth/session";
import { setWallet } from "@/lib/payouts";

export async function setWalletAction(input: unknown): Promise<Result<{ walletAddress: string }>> {
  const actor = await requireUser();
  const parsed = z.string().max(100).safeParse(input);
  if (!parsed.success) return fail("Enter a wallet address.");
  const result = await setWallet(actor, parsed.data);
  revalidatePath("/", "layout"); // the missing-wallet banner shows on several pages
  return result;
}
