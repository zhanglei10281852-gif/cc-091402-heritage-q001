import assert from "node:assert/strict";
import test from "node:test";
import { startServer, call, ADMIN } from "./helpers.js";

test("HTTP 端到端：考古移交批次从录入、编号冲突、登记到保险估值", async (context) => {
  const server = await startServer();
  context.after(server.close);

  const batch = await call(server, "POST", "/v1/batches", {
    actor: ADMIN,
    note: "2026 秋季考古移交",
  });
  assert.equal(batch.status, 200);
  const batchId = batch.body.batch.id;

  const created = await call(server, "POST", "/v1/artifacts", {
    actor: ADMIN,
    batchId,
    info: { name: "青釉瓷碗", category: "瓷器", dynasty: "北宋" },
    excavation: { site: "龙泉窑遗址", location: "Y3" },
    numbers: [
      { number: "JD-001", namespace: "旧纸档" },
      { number: "LS-77", namespace: "临时清单" },
      { number: "SCAN-88", namespace: "库房扫描" },
    ],
  });
  assert.equal(created.status, 200);
  const artifactId = created.body.artifact.id;

  const dup = await call(server, "POST", "/v1/artifacts", {
    actor: ADMIN,
    batchId,
    info: { name: "疑似重复件", category: "瓷器" },
    numbers: [{ number: "JD-001", namespace: "库房扫描" }],
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "conflict");
  assert.ok(dup.body.error.details.reasons[0].message.length > 0);
  assert.equal(dup.body.error.details.reasons[0].heldBy, artifactId);

  const registered = await call(server, "POST", `/v1/artifacts/${artifactId}/register`, {
    actor: ADMIN,
  });
  assert.equal(registered.body.artifact.status, "registered");

  const appraisal = await call(server, "PUT", `/v1/artifacts/${artifactId}/appraisal`, {
    actor: ADMIN,
    appraisal: { value: 800000, currency: "CNY", insurer: "人保财险", policyNo: "BX-77" },
    basis: { document: "估值报告", documentId: "GZ-2026-044" },
  });
  assert.equal(appraisal.status, 200);
  assert.equal(appraisal.body.artifact.appraisal.policyNo, "BX-77");

  const byOldNumber = await call(
    server,
    "GET",
    "/v1/numbers/resolve?number=" + encodeURIComponent("ls-77"),
  );
  assert.equal(byOldNumber.body.resolution.artifactId, artifactId);

  const fetched = await call(server, "GET", `/v1/artifacts/${artifactId}`);
  assert.equal(fetched.body.immutableIdentity.fingerprint.split("|").length, 3);
});

test("HTTP 支持用请求头传递经办人，且只读访客写入返回 403", async (context) => {
  const server = await startServer();
  context.after(server.close);

  // HTTP 头只能携带 Latin-1 字符，因此头方式传工号；中文姓名与角色放在请求体内合并。
  const batch = await call(server, "POST", "/v1/batches", {
    actor: { name: "头经办人", role: "管理员" },
  }, {
    headers: {
      "x-actor-id": "u-hdr",
    },
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.batch.openedBy.id, "u-hdr");
  assert.equal(batch.body.batch.openedBy.role, "管理员");

  // HTTP 头只能携带 Latin-1 字符，因此工号走请求头、中文角色放请求体合并。
  const denied = await call(
    server,
    "POST",
    `/v1/batches/${batch.body.batch.id}/seal`,
    { actor: { name: "张访客", role: "只读访客" } },
    {
      headers: {
        "x-actor-id": "u-view",
      },
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "forbidden");
});

test("HTTP 跨馆移交全链路，核对包与链头可拉取", async (context) => {
  const server = await startServer();
  context.after(server.close);

  const batchId = (await call(server, "POST", "/v1/batches", { actor: ADMIN })).body.batch.id;
  const artifactId = (
    await call(server, "POST", "/v1/artifacts", {
      actor: ADMIN,
      batchId,
      info: { name: "青铜剑", category: "青铜器" },
      numbers: [{ number: "JIAN-9", namespace: "库房扫描" }],
    })
  ).body.artifact.id;
  await call(server, "POST", `/v1/artifacts/${artifactId}/register`, { actor: ADMIN });

  const transfer = await call(server, "POST", "/v1/transfers", {
    actor: ADMIN,
    artifactIds: [artifactId],
    fromOrg: "市博物馆",
    toOrg: "省博物馆",
    reason: "巡展",
  });
  assert.equal(transfer.status, 200);
  const transferId = transfer.body.transfer.id;

  const dispatch = await call(server, "POST", `/v1/transfers/${transferId}/dispatch`, {
    actor: ADMIN,
  });
  const code = dispatch.body.verificationCode;
  assert.match(code, /^evt_/);

  const wrongCode = await call(server, "POST", `/v1/transfers/${transferId}/accept`, {
    actor: { id: "u9", name: "接收员", role: "管理员" },
    verificationCode: "evt_fake",
  });
  assert.equal(wrongCode.status, 409);

  const accept = await call(server, "POST", `/v1/transfers/${transferId}/accept`, {
    actor: { id: "u9", name: "接收员", role: "管理员" },
    verificationCode: code,
  });
  assert.equal(accept.status, 200);

  const pkg = await call(server, "GET", `/v1/transfers/${transferId}/package`);
  assert.equal(pkg.body.transfer.status, "accepted");
  assert.ok(pkg.body.events.length >= 3);

  const chain = await call(server, "GET", "/v1/chain");
  assert.equal(chain.status, 200);
  assert.equal(chain.body.head, chain.body.chain.at(-1).hash);
});

test("HTTP 审计接口可按批次过滤，事件含哈希链证据", async (context) => {
  const server = await startServer();
  context.after(server.close);

  const batchId = (await call(server, "POST", "/v1/batches", { actor: ADMIN })).body.batch.id;
  const audit = await call(server, "GET", `/v1/audit?batchId=${encodeURIComponent(batchId)}`);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.count, 1);
  assert.equal(audit.body.events[0].type, "batch_opened");
  assert.match(audit.body.events[0].hash, /^[0-9a-f]{64}$/);
});

test("非法 JSON 与缺少经办人返回明确的 400", async (context) => {
  const server = await startServer();
  context.after(server.close);

  const bad = await fetch(server.base + "/v1/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
  const json = await bad.json();
  assert.equal(json.error.code, "validation_error");

  const noActor = await call(server, "POST", "/v1/batches", { note: "x" });
  assert.equal(noActor.status, 400);
});
