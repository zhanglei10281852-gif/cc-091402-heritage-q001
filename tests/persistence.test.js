import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { startHarness, registerBody, OPERATOR } from "./helpers/harness.js";

async function registerConfirmed(api, overrides) {
  const res = await api.post("/v1/artifacts", registerBody(overrides));
  const id = res.body.data.artifactId;
  await api.post("/v1/artifacts/" + id + "/confirm", {
    operator: OPERATOR,
    basis: { type: "复核签字", summary: "三源编号核对一致" },
  });
  return id;
}

test("重启后按器物、批次、时间均可还原当前状态与全部历史", async (context) => {
  const { api, restart } = await startHarness(context);
  const id = await registerConfirmed(api);
  await api.post("/v1/artifacts/" + id + "/location-moves", {
    operator: OPERATOR,
    location: { code: "B-09-01" },
    basis: { type: "调拨单", summary: "移库" },
  });

  await restart();

  const detail = await api.get("/v1/artifacts/" + id);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.status, "registered");
  assert.equal(detail.body.data.currentLocation.code, "B-09-01");
  assert.equal(detail.body.data.locationHistory.length, 2);
  assert.equal(detail.body.data.identifiers.length, 3);

  const batch = await api.get("/v1/batches/batch-2026-0901");
  assert.equal(batch.body.data.artifacts.length, 1);

  const history = await api.get("/v1/artifacts/" + id + "/history");
  const types = history.body.data.events.map((event) => event.type);
  assert.deepEqual(types, ["ArtifactRegistered", "ArtifactConfirmed", "LocationMoved"]);
  // 哈希链字段随历史返回，管理员可据此复核。
  assert.ok(history.body.data.events[0].hash);
  assert.equal(history.body.data.events[1].prevHash, history.body.data.events[0].hash);

  // 重启后编号唯一性约束仍然生效。
  const dup = await api.post("/v1/artifacts", registerBody({ basicInfo: { name: "重复" } }));
  assert.equal(dup.status, 409);
});

test("审计事件支持按类型/批次/器物/时间窗过滤，并含经办人与依据", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerConfirmed(api);
  const byType = await api.get("/v1/audit/events?type=ArtifactConfirmed");
  assert.equal(byType.body.data.events.length, 1);
  assert.equal(byType.body.data.events[0].operator.name, "李馆员");
  assert.equal(byType.body.data.events[0].basis.summary, "三源编号核对一致");

  const byBatch = await api.get("/v1/audit/events?batchId=batch-2026-0901");
  assert.ok(byBatch.body.data.events.length >= 2);

  const byArtifact = await api.get("/v1/audit/events?artifactId=" + id);
  assert.ok(byArtifact.body.data.events.every((event) => event.data.artifactId === id || event.data.artifactIds?.includes?.(id)));

  const byTime = await api.get("/v1/audit/events?from=2026-09-01T00:00:00%2B08:00&to=2026-09-02T00:00:00%2B08:00");
  assert.ok(byTime.body.data.events.length >= 2);

  const status = await api.get("/v1/ledger/status");
  assert.equal(status.body.data.verified, true);
  assert.ok(/^[0-9a-f]{64}$/.test(status.body.data.headHash));
});

test("账本被篡改时服务拒绝启动，避免在不可信状态上继续登记", async (context) => {
  const { api, restart, dataFile } = await startHarness(context);
  await registerConfirmed(api);
  await api.post("/v1/artifacts/artifact-0001/location-moves", {
    operator: OPERATOR,
    location: { code: "Z-00-00" },
    basis: { type: "调拨单", summary: "移库" },
  });

  // 直接改账本中一行的业务内容（模拟有人绕过系统改数据文件）。
  const lines = (await readFile(dataFile, "utf8")).trim().split("\n");
  const tampered = lines[lines.length - 1].replace("Z-00-00", "HACK-99-99");
  lines[lines.length - 1] = tampered;
  await writeFile(dataFile, lines.join("\n") + "\n");

  await assert.rejects(
    () => restart(),
    (error) => error.code === "LEDGER_TAMPERED",
  );
});

test("跨重启的合并谱系：合并发生在重启前，重启后仍可完整追溯", async (context) => {
  const { api, restart } = await startHarness(context);
  const a = await registerConfirmed(api, { identifiers: [{ value: "AAA-1", system: "temporary" }] });
  const b = await registerConfirmed(api, {
    identifiers: [{ value: "BBB-1", system: "temporary" }],
    basicInfo: { name: "重复件" },
  });
  const merge = await api.post("/v1/artifacts/merge", {
    operator: OPERATOR,
    survivorId: a,
    sourceIds: [b],
    basis: { type: "比对结论", summary: "同一器物" },
  });
  assert.equal(merge.status, 200);

  await restart();
  const lineage = await api.get("/v1/artifacts/" + b + "/lineage");
  assert.ok(lineage.body.data.edges.some((edge) => edge.from === b && edge.to === a));
  const list = await api.get("/v1/artifacts?status=merged");
  assert.equal(list.body.data.artifacts[0].id, b);
});
