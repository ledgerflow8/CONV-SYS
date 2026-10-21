-- A new country source: Capitalbot's tier verdict, used when a fan's phone is hidden.
-- A normal AI reply marks the convo Tier 1 (country "T1"); a tierFiltered verdict rejects it
-- as non_tier1. Postgres 12+ allows ADD VALUE inside the migration transaction (the value is
-- not used in this same transaction).
ALTER TYPE "CountrySrc" ADD VALUE 'CAPITALBOT';
