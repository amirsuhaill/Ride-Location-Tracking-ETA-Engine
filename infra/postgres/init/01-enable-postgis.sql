-- The postgis/postgis image already enables PostGIS on the default database,
-- but we do it explicitly and idempotently so it's never a silent assumption.
CREATE EXTENSION IF NOT EXISTS postgis;
