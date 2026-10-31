-- Telegram's PeerSettings shows a hidden-number sender's phone country (real ISO-2); the panel sends
-- it as `phoneCountry` and ingest records it with this source. Postgres 12+ allows ADD VALUE in the
-- migration transaction (the value isn't used in this same transaction).
ALTER TYPE "CountrySrc" ADD VALUE 'TG_PHONE_COUNTRY';
