import { resolve } from "node:path";
import { createApp as createRouter } from "./http/router.js";
import { HeritageService } from "./services/heritage-service.js";

// 无参调用保持基础工程的轻量行为（仅健康检查）；
// 传入 { dataDir } 时装配完整的馆藏登记服务。
export function createApp(options) {
  if (arguments.length === 0) return createRouter();

  const dataDir =
    options.dataDir ?? process.env.DATA_DIR ?? resolve(process.cwd(), ".runtime/data");
  const service = new HeritageService({ dataDir, clock: options.clock });
  const info = service.start();
  const server = createRouter(service);
  server.service = service;
  server.startupInfo = info;
  return server;
}
