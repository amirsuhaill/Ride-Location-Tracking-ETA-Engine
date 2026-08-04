import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface OsrmStub {
  url: string;
  close: () => Promise<void>;
}

/**
 * Starts a real local HTTP server standing in for OSRM, so the failure-mode tests
 * (test/eta-osrm-fallback.test.ts) exercise genuine socket/timeout behavior — same rationale as
 * test/helpers/ml-stub-server.ts (Phase 10): a mocked `fetch` wouldn't actually exercise
 * AbortController-driven request cancellation the way a real slow-responding server does.
 */
export async function startOsrmStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<OsrmStub> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Responds 200 with a valid OSRM /route body (`code: "Ok"` + one route). */
export function osrmOkHandler(distanceMeters: number, durationSeconds: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code: "Ok",
        routes: [{ distance: distanceMeters, duration: durationSeconds }],
        waypoints: [],
      }),
    );
  };
}

/** Responds after `delayMs` — exercises the timeout path when delayMs exceeds the configured
 * osrmTimeoutMs. */
export function osrmSlowHandler(delayMs: number, distanceMeters: number, durationSeconds: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: "Ok",
          routes: [{ distance: distanceMeters, duration: durationSeconds }],
          waypoints: [],
        }),
      );
    }, delayMs);
  };
}

/** Responds HTTP 400 with a `{"code":"NoSegment"|"NoRoute", "message": ...}` body — the real,
 * verified shape a live OSRM instance returns when a point can't be routed (docs/osrm-routing.md),
 * as opposed to ml-service's 200-with-error-code convention. */
export function osrmNoRouteHandler(code: "NoSegment" | "NoRoute" = "NoSegment") {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code, message: `simulated ${code}` }));
  };
}

/** Responds with a non-2xx, non-routing-failure status (e.g. 500) and no recognizable `code`. */
export function osrmErrorStatusHandler(statusCode: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "simulated osrm error" }));
  };
}

/** Responds 200 with `code: "Ok"` but a body that doesn't match the expected routes shape. */
export function osrmMalformedHandler() {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "Ok", unexpected: "shape" }));
  };
}
