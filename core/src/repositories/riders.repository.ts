import { pool } from "../db";
import type { CreateRiderInput } from "../schemas/riders";

export interface Rider {
  id: string;
  name: string;
  createdAt: Date;
}

export async function insertRider(input: CreateRiderInput): Promise<Rider> {
  const { rows } = await pool.query<Rider>(
    `INSERT INTO riders (name) VALUES ($1)
     RETURNING id, name, created_at AS "createdAt"`,
    [input.name],
  );
  const row = rows[0];
  if (!row) throw new Error("insertRider: INSERT ... RETURNING produced no row");
  return row;
}

export async function findRiderById(id: string): Promise<Rider | null> {
  const { rows } = await pool.query<Rider>(
    `SELECT id, name, created_at AS "createdAt" FROM riders WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
