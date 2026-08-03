exports.shorthands = undefined;

/**
 * Native enum types (rather than a CHECK constraint on text) so the set of legal values lives in
 * one place, `\d+ <type>` self-documents it, and adding a value later is a single ALTER TYPE ...
 * ADD VALUE instead of rewriting a CHECK expression on every table that uses it.
 */
exports.up = (pgm) => {
  pgm.createType("driver_status", ["online", "offline", "busy"]);
  pgm.createType("trip_status", ["requested", "matched", "in_progress", "completed", "cancelled"]);
};

exports.down = (pgm) => {
  pgm.dropType("trip_status");
  pgm.dropType("driver_status");
};
