exports.shorthands = undefined;

/**
 * FK ON DELETE choices (see docs/schema.md for the full write-up):
 * - rider_id -> RESTRICT: trips are the historical/billing record and future ETA-model training
 *   data. A rider must not be deletable while trips reference them — deleting silently cascading
 *   away trip history would corrupt that record. Forces an explicit decision (e.g. soft-delete
 *   riders) instead.
 * - driver_id -> SET NULL: same "don't destroy trip history" reasoning, but driver_id is already
 *   nullable (a trip can be unmatched), so detaching a deleted driver from their past trips is
 *   consistent with that and preserves the trip row for training/reporting.
 */
exports.up = (pgm) => {
  pgm.createTable("trips", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    rider_id: {
      type: "uuid",
      notNull: true,
      references: "riders",
      onDelete: "RESTRICT",
    },
    driver_id: {
      type: "uuid",
      notNull: false,
      references: "drivers",
      onDelete: "SET NULL",
    },
    pickup_location: { type: "geography(Point,4326)", notNull: true },
    dropoff_location: { type: "geography(Point,4326)", notNull: true },
    status: { type: "trip_status", notNull: true, default: "requested" },
    requested_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    matched_at: { type: "timestamptz", notNull: false },
    started_at: { type: "timestamptz", notNull: false },
    completed_at: { type: "timestamptz", notNull: false },
    distance_meters: { type: "double precision", notNull: false },
    duration_seconds: { type: "integer", notNull: false },
    cancellation_reason: { type: "text", notNull: false },
  });

  pgm.createIndex("trips", "status", { name: "idx_trips_status" });
  pgm.createIndex("trips", "rider_id", { name: "idx_trips_rider_id" });
  pgm.createIndex("trips", "driver_id", { name: "idx_trips_driver_id" });
  pgm.createIndex("trips", "pickup_location", {
    name: "idx_trips_pickup_location_gist",
    method: "gist",
  });
  pgm.createIndex("trips", "dropoff_location", {
    name: "idx_trips_dropoff_location_gist",
    method: "gist",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("trips");
};
