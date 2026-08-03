exports.shorthands = undefined;

/**
 * infra/postgres/init/01-enable-postgis.sql already enables PostGIS for the docker-compose
 * Postgres container. This migration exists so `migrate:up` also works standalone against any
 * fresh database (e.g. a CI database that isn't bootstrapped from that init script).
 */
exports.up = (pgm) => {
  pgm.createExtension("postgis", { ifNotExists: true });
};

exports.down = (pgm) => {
  // The postgis/postgis Docker image also bootstraps postgis_topology and
  // postgis_tiger_geocoder, both of which depend on postgis — a plain DROP EXTENSION fails
  // against those. We don't own or use those two, so cascading them away on rollback is safe;
  // by this point every table of ours that used a geography column has already been dropped by
  // the later migrations' down steps.
  pgm.dropExtension("postgis", { ifExists: true, cascade: true });
};
