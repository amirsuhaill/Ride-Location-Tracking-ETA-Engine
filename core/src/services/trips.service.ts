import * as tripsRepo from "../repositories/trips.repository";
import type { Trip } from "../repositories/trips.repository";
import * as ridersRepo from "../repositories/riders.repository";
import { NotFoundError } from "../errors";
import type { CreateTripInput } from "../schemas/trips";

export async function requestTrip(input: CreateTripInput): Promise<Trip> {
  const rider = await ridersRepo.findRiderById(input.riderId);
  if (!rider) throw new NotFoundError(`Rider ${input.riderId} not found`);
  return tripsRepo.insertTrip(input);
}

export async function getTrip(id: string): Promise<Trip> {
  const trip = await tripsRepo.findTripById(id);
  if (!trip) throw new NotFoundError(`Trip ${id} not found`);
  return trip;
}
