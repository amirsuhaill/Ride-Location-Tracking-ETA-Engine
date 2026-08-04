exports.shorthands = undefined;

/**
 * Dedicated table for Phase 8's historical trip simulator — see docs/historical-data-simulator.md
 * for the full rationale for why this is separate from `trips` rather than reusing it (short
 * version: `trips` is real operational/rider-facing state that the rest of this system reads and
 * writes; this table is a disposable, re-generatable ML training corpus with columns — the naive
 * baseline figures and the individual injected-variance factors — that have no meaning for a real
 * trip and would only pollute that schema). No FK to riders/drivers: these rows don't represent
 * anything that happened to a real rider or driver.
 */
exports.up = (pgm) => {
  pgm.createTable("training_trips", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    pickup_location: { type: "geography(Point,4326)", notNull: true },
    dropoff_location: { type: "geography(Point,4326)", notNull: true },
    requested_at: { type: "timestamptz", notNull: true },
    // "Naive" = straight-line haversine distance / a constant average speed, with NO adjustment
    // at all — the deliberately-dumb baseline the prompt warns against making the actual figures
    // equal to.
    naive_distance_meters: { type: "double precision", notNull: true },
    naive_duration_seconds: { type: "double precision", notNull: true },
    // "Actual" = the simulated ground truth: naive distance inflated by a road-circuity factor,
    // then naive duration adjusted by all three independent variance factors below.
    actual_distance_meters: { type: "double precision", notNull: true },
    actual_duration_seconds: { type: "double precision", notNull: true },
    // The three independent injected-variance factors actually applied to this row, stored
    // explicitly (not just baked into actual_duration_seconds) so Phase 9's model can use them as
    // features/labels for evaluating what it learned, and so this dataset's signal is directly
    // inspectable per-row, not just in aggregate.
    time_of_day_multiplier: { type: "double precision", notNull: true },
    zone_density_factor: { type: "double precision", notNull: true },
    noise_factor: { type: "double precision", notNull: true },
    // Which simulator run produced this row — lets a re-run with the same seed delete and
    // replace exactly its own prior rows (idempotent, like Phase 1's seed script) instead of
    // accumulating duplicates, and lets multiple distinct simulated datasets coexist.
    simulation_seed: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("training_trips", "requested_at", {
    name: "idx_training_trips_requested_at",
  });
  pgm.createIndex("training_trips", "simulation_seed", {
    name: "idx_training_trips_simulation_seed",
  });
  pgm.createIndex("training_trips", "pickup_location", {
    name: "idx_training_trips_pickup_location_gist",
    method: "gist",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("training_trips");
};
