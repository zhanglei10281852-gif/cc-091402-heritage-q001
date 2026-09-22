import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

export function tempDataDir() {
  return mkdtempSync(join(tmpdir(), "heritage-"));
}

export async function startServer(dataDir = tempDataDir()) {
  const server = createApp({ dataDir });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    base,
    dataDir,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

export function actor(overrides = {}) {
  return { id: "u-admin", name: "王管理员", role: "管理员", ...overrides };
}

export async function call(server, method, path, body, { headers = {} } = {}) {
  const response = await fetch(server.base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

export const ADMIN = { id: "u-admin", name: "王管理员", role: "管理员" };
export const CURATOR = { id: "u-curator", name: "李保护", role: "保护人员" };
export const VIEWER = { id: "u-viewer", name: "张访客", role: "只读访客" };
