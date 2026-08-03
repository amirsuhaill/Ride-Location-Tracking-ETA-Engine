// Tracks cumulative bytes-out for location broadcasts: what would have been sent if every
// message were a full {driverId,lat,lng,timestamp,status} payload, vs what was actually sent
// after delta compression. This is the in-process signal referenced in
// docs/ws-batching-and-compression.md; the authoritative, repeatable measurement is the load
// test script's own client-observed numbers, but this gives real-time visibility while the
// service is running.
interface BandwidthTotals {
  messagesSent: number;
  fullPayloadEquivalentBytes: number;
  actualBytesSent: number;
}

let totals: BandwidthTotals = {
  messagesSent: 0,
  fullPayloadEquivalentBytes: 0,
  actualBytesSent: 0,
};

export function recordMessage(fullPayloadBytes: number, actualBytes: number): void {
  totals.messagesSent += 1;
  totals.fullPayloadEquivalentBytes += fullPayloadBytes;
  totals.actualBytesSent += actualBytes;
}

export interface BandwidthSummary extends BandwidthTotals {
  bytesSaved: number;
  savingsPercent: number;
}

export function getBandwidthStats(): BandwidthSummary {
  const bytesSaved = totals.fullPayloadEquivalentBytes - totals.actualBytesSent;
  const savingsPercent =
    totals.fullPayloadEquivalentBytes > 0
      ? (bytesSaved / totals.fullPayloadEquivalentBytes) * 100
      : 0;
  return { ...totals, bytesSaved, savingsPercent };
}

export function logBandwidthSummary(): void {
  const stats = getBandwidthStats();
  if (stats.messagesSent === 0) return;
  console.log(
    `[ws-bandwidth] ${stats.messagesSent} messages: ${stats.fullPayloadEquivalentBytes}B full-equivalent -> ` +
      `${stats.actualBytesSent}B actual (${stats.savingsPercent.toFixed(1)}% saved)`,
  );
}

export function resetBandwidthMetricsForTests(): void {
  totals = { messagesSent: 0, fullPayloadEquivalentBytes: 0, actualBytesSent: 0 };
}

let logTimer: NodeJS.Timeout | undefined;

export function startBandwidthLogLoop(intervalMs: number): void {
  if (logTimer) return;
  logTimer = setInterval(logBandwidthSummary, intervalMs);
  logTimer.unref();
}

export function stopBandwidthLogLoop(): void {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = undefined;
  }
}
