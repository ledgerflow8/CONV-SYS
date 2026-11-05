-- Add FROZEN to TgStatus: a replaced account kept out of the pool with its past convos intact.
ALTER TYPE "TgStatus" ADD VALUE IF NOT EXISTS 'FROZEN';
