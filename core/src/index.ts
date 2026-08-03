import { buildServer } from "./server";
import { config } from "./config";

const app = buildServer();

app
  .listen({ port: config.port, host: config.host })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
