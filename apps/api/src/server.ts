import { createApiServer } from "./app.js";
import { readConfig } from "./config.js";
import { OnePasswordService } from "./onepassword.js";

const config = readConfig();
const server = await createApiServer({
  config,
  onePassword: new OnePasswordService()
});

await server.listen({ host: config.host, port: config.port });
server.log.info(`Local API: http://${config.host}:${config.port}`);
