exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable("drivers", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: { type: "text", notNull: true },
    vehicle_make: { type: "text", notNull: true },
    vehicle_model: { type: "text", notNull: true },
    vehicle_color: { type: "text", notNull: true },
    vehicle_plate: { type: "text", notNull: true },
    status: { type: "driver_status", notNull: true, default: "offline" },
    // Nullable: a driver has no location until their first app-open/location ping.
    current_location: { type: "geography(Point,4326)", notNull: false },
    last_updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("drivers", "status", { name: "idx_drivers_status" });
  pgm.createIndex("drivers", "current_location", {
    name: "idx_drivers_current_location_gist",
    method: "gist",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("drivers");
};
