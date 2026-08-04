import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface MlStub {
  url: string;
  close: () => Promise<void>;
}

/**
 * Starts a real local HTTP server standing in for ml-service, so the three ML-failure-mode
 * tests (test/eta-ml-fallback.test.ts) exercise genuine socket/timeout behavior — a mocked
 * `fetch` that just resolves after a delay wouldn't actually exercise AbortController-driven
 * request cancellation the way a real slow-responding server does.
 */
export async function startMlStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MlStub> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Responds 200 with a valid /predict-eta body. */
export function mlOkHandler(etaSeconds: number, distanceMeters: number, modelVersion = "test-v1") {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        predicted_duration_seconds: etaSeconds,
        distance_meters: distanceMeters,
        model_version: modelVersion,
      }),
    );
  };
}

/** Responds after `delayMs` — used to exercise the timeout path when delayMs exceeds the
 * configured mlTimeoutMs. */
export function mlSlowHandler(delayMs: number, etaSeconds: number, distanceMeters: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          predicted_duration_seconds: etaSeconds,
          distance_meters: distanceMeters,
          model_version: "test-v1",
        }),
      );
    }, delayMs);
  };
}

/** Responds with a non-2xx status (e.g. 500, 422) and no usable body. */
export function mlErrorStatusHandler(statusCode: number) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "simulated ml-service error" }));
  };
}

/** Responds 200 but with a body that doesn't match the expected prediction shape. */
export function mlMalformedHandler() {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ unexpected: "shape" }));
  };
}
