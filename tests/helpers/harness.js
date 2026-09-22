import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.js";

export async function startHarness(context, { fixedClock } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "heritage-test-"));
  context.after(() => rm(dir, { recursive: true, force: true }));

  let current = fixedClock ? new Date(fixedClock) : new Date("2026-09-01T09:00:00+08:00");
  const clock = () => current;
  const tick = (iso) => {
    current = new Date(iso);
  };
  const advance = (minutes) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  const dataFile = join(dir, "ledger.jsonl");
  let server = await createApp({ dataFile, clock });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await server.shutdown();
  });

  const api = {
    async request(method, path, body) {
      const port = server.address().port;
      const response = await fetch("http://127.0.0.1:" + port + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json();
      return { status: response.status, body: json };
    },
    get(path) {
      return this.request("GET", path);
    },
    post(path, body) {
      return this.request("POST", path, body ?? {});
    },
    patch(path, body) {
      return this.request("PATCH", path, body ?? {});
    },
  };

  // 模拟进程重启：关闭 HTTP 与账本句柄后用同一数据文件重新装配，
  // 用于验证状态完全由事件重放恢复。
  const restart = async () => {
    await server.shutdown();
    server = await createApp({ dataFile, clock });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  };

  return { api, restart, tick, advance, dataFile, dir };
}

export const OPERATOR = { id: "u-001", name: "李馆员", role: "管理员" };
export const APPRAISER = { id: "u-101", name: "王专家", role: "鉴定人" };

export function registerBody(overrides = {}) {
  return {
    batchId: "batch-2026-0901",
    operator: OPERATOR,
    basis: { type: "考古移交单", summary: "2026年秋季考古队移交", documentRef: "DOC-2026-0901" },
    basicInfo: {
      name: "青釉瓷碗",
      category: "瓷器",
      dynasty: "宋",
      material: "瓷",
      dimensions: "口径12cm",
    },
    excavation: {
      site: "东郊遗址",
      location: "T2探方第3层",
      excavatedAt: "2026-08-20",
      method: "考古发掘",
    },
    photoIds: ["photo-a-001", "photo-a-002"],
    location: { code: "A-01-03", note: "恒温柜" },
    identifiers: [
      { value: "JIU-001", system: "paper-legacy", note: "旧纸档编号" },
      { value: "LIN-2026-17", system: "interim-list" },
      { value: "SCAN-A9F3", system: "warehouse-scan" },
    ],
    ...overrides,
  };
}
