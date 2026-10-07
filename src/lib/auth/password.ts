// All password generation and changes go through here, so changing a password
// always ends that user's existing sessions.
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";

const BCRYPT_ROUNDS = 10;
// No 0/O/1/l/I so passwords survive being read off a phone screen.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/** Sets a new password and invalidates every existing session for the user. */
export async function setPassword(tx: Prisma.TransactionClient, userId: string, plaintext: string) {
  await tx.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(plaintext), sessionVersion: { increment: 1 } },
  });
}
