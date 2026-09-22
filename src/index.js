import { resolve } from "node:path";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = createApp({
  dataDir: process.env.DATA_DIR ?? resolve(process.cwd(), ".runtime/data"),
});
server.listen(port, host, () => {
  const { eventCount, verified, headHash } = server.startupInfo;
  console.log(
    JSON.stringify({
      message: "馆藏登记与谱系追踪服务已启动",
      host,
      port,
      eventCount,
      hashChainVerified: verified,
      headHash,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
