import { createApp } from "./app.js";
import { LedgerTamperedError } from "./store/event-log.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  const server = await createApp();
  server.listen(port, host, () => console.log("馆藏登记服务已启动：http://" + host + ":" + port));
} catch (error) {
  if (error instanceof LedgerTamperedError) {
    console.error("启动中止：事件账本未通过完整性校验。", error.message, error.details ?? "");
    process.exit(2);
  }
  console.error("服务启动失败：", error);
  process.exit(1);
}
