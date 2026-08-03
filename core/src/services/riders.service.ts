import * as ridersRepo from "../repositories/riders.repository";
import type { Rider } from "../repositories/riders.repository";
import { NotFoundError } from "../errors";
import type { CreateRiderInput } from "../schemas/riders";

export async function createRider(input: CreateRiderInput): Promise<Rider> {
  return ridersRepo.insertRider(input);
}

export async function getRider(id: string): Promise<Rider> {
  const rider = await ridersRepo.findRiderById(id);
  if (!rider) throw new NotFoundError(`Rider ${id} not found`);
  return rider;
}
