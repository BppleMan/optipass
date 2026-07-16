import { createApiServer } from "./app.js";
import { readConfig } from "./config.js";
import { OnePasswordService } from "./onepassword.js";
import { createDefaultApplicationServices } from "./application-services.js";

const config = readConfig();
const onePassword = new OnePasswordService();
const server = await createApiServer({
  config,
  services: createDefaultApplicationServices(onePassword)
});

await server.listen({ host: config.host, port: config.port });
server.log.info(`Local API: http://${config.host}:${config.port}`);
