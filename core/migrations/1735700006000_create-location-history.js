exports.shorthands = undefined;

/**
 * FK ON DELETE choices (see docs/schema.md):
 * - trip_id -> CASCADE: a location breadcrumb is meaningless without the trip it belongs to, and
 *   this table is high-volume/time-series in nature (no billing/legal reason to keep it once its
 *   parent trip is gone) — CASCADE avoids orphaned rows without needing a cleanup job.
 * - driver_id -> CASCADE: same reasoning — a ping tied to a permanently-deleted driver is no
 *   longer attributable to anyone and should go with them.
 *
 * bigint identity (not uuid) for the PK: this table is expected to be the highest-volume one
 * (a row per location tick), so sequential, smaller (8-byte) keys keep index size and insert
 * locality better than random uuids, and nothing external ever needs to guess these ids.
 */
exports.up = (pgm) => {
  pgm.createTable("location_history", {
    id: { type: "bigserial", primaryKey: true },
    trip_id: {
      type: "uuid",
      notNull: false,
      references: "trips",
      onDelete: "CASCADE",
    },
    driver_id: {
      type: "uuid",
      notNull: false,
      references: "drivers",
      onDelete: "CASCADE",
    },
    location: { type: "geography(Point,4326)", notNull: true },
    recorded_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("location_history", "location_history_owner_check", {
    check: '"trip_id" IS NOT NULL OR "driver_id" IS NOT NULL',
  });

  pgm.createIndex("location_history", "recorded_at", {
    name: "idx_location_history_recorded_at",
  });
  pgm.createIndex("location_history", "trip_id", {
    name: "idx_location_history_trip_id",
  });
  pgm.createIndex("location_history", "driver_id", {
    name: "idx_location_history_driver_id",
  });
  pgm.createIndex("location_history", "location", {
    name: "idx_location_history_location_gist",
    method: "gist",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("location_history");
};
