import { createServer } from "node:http";
import { resolve } from "node:path";
import { EventLog, LedgerTamperedError } from "./store/event-log.js";
import { HeritageService } from "./domain/heritage-service.js";
import { createRouter } from "./http/router.js";

export async function createApp(options = {}) {
  const dataFile =
    options.dataFile ?? process.env.DATA_FILE ?? resolve(process.cwd(), ".data/heritage-ledger.jsonl");
  const institution = {
    code: process.env.INSTITUTION_CODE ?? "MUS",
    name: process.env.INSTITUTION_NAME ?? "市级博物馆",
  };
  const log = new EventLog(dataFile);
  const service = new HeritageService({ log, institution, clock: options.clock });
  await service.start();

  const router = createRouter(service);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", service: "heritage-registry" }));
      return;
    }
    return router(request, response);
  });

  server.service = service;
  server.eventLog = log;
  let shuttingDown = null;
  server.shutdown = async () => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      await service.close();
    })();
    return shuttingDown;
  };
  return server;
}

export { LedgerTamperedError };
