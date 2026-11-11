import { createServer } from "node:http";

import { createApp } from "./app.js";
import { config } from "./config.js";
import { createPgDb } from "./db.js";
import { refreshDoses } from "./domain/doses.js";

const db = await createPgDb(config.databaseUrl);
const server = createServer(createApp(db));

server.listen(config.port, () => {
  console.log(`Zelo API ouvindo na porta ${config.port}`);
});

// A cada minuto: cria as doses de hoje e marca as atrasadas (avisando os cuidadores).
const timer = setInterval(() => {
  refreshDoses(db).catch((error) => console.error("Falha na rotina de doses:", error));
}, 60_000);

const shutdown = () => {
  clearInterval(timer);
  server.close(() => db.close().finally(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
