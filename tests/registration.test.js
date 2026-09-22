import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, registerBody, OPERATOR } from "./helpers/harness.js";

test("为器物建立不可变身份，三类来源编号一并入库", async (context) => {
  const { api } = await startHarness(context);
  const res = await api.post("/v1/artifacts", registerBody());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.artifactId, "artifact-0001");
  assert.equal(res.body.data.artifact.status, "draft");
  assert.equal(res.body.data.artifact.batchId, "batch-2026-0901");
  const systems = res.body.data.artifact.identifiers.map((item) => item.system).sort();
  assert.deepEqual(systems, ["interim-list", "paper-legacy", "warehouse-scan"]);

  const single = await api.get("/v1/artifacts/artifact-0001");
  assert.equal(single.body.data.basicInfo.name, "青釉瓷碗");
  assert.equal(single.body.data.excavation.site, "东郊遗址");
});

test("同批次并发录入同一编号：只生成一个身份，另一个返回带复核信息的冲突", async (context) => {
  const { api } = await startHarness(context);
  const body = registerBody();
  const [first, second] = await Promise.all([
    api.post("/v1/artifacts", body),
    api.post("/v1/artifacts", registerBody({ basicInfo: { name: "重复器物" } })),
  ]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [200, 409]);
  const ok = first.status === 200 ? first : second;
  const fail = first.status === 409 ? first : second;
  assert.equal(ok.body.data.artifactId, "artifact-0001");
  assert.equal(fail.body.error.code, "IDENTIFIER_CONFLICT");
  assert.equal(fail.body.error.details.conflicts[0].ownerArtifactId, "artifact-0001");
  assert.match(fail.body.error.message, /不可变身份/);
  assert.ok(fail.body.error.details.hint);

  const list = await api.get("/v1/artifacts");
  assert.equal(list.body.data.artifacts.length, 1);
});

test("编号大小写/空白归一化后仍能识别冲突", async (context) => {
  const { api } = await startHarness(context);
  await api.post("/v1/artifacts", registerBody());
  const dup = await api.post(
    "/v1/artifacts",
    registerBody({ identifiers: [{ value: " jiu-001 ", system: "paper-legacy" }], basicInfo: { name: "另一碗" } }),
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "IDENTIFIER_CONFLICT");
});

test("客户端幂等键：重试登记返回既有身份而非新建", async (context) => {
  const { api } = await startHarness(context);
  const body = registerBody({ clientRequestId: "req-7f3a" });
  const first = await api.post("/v1/artifacts", body);
  const retry = await api.post("/v1/artifacts", body);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.reused, true);
  assert.equal(retry.body.data.artifactId, first.body.data.artifactId);
});

test("草稿确认后成为正式登记，重复确认被拒绝", async (context) => {
  const { api } = await startHarness(context);
  await api.post("/v1/artifacts", registerBody());
  const confirm = await api.post("/v1/artifacts/artifact-0001/confirm", {
    operator: OPERATOR,
    basis: { type: "复核签字", summary: "三源编号核对一致，准予登记" },
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.data.status, "registered");

  const again = await api.post("/v1/artifacts/artifact-0001/confirm", {
    operator: OPERATOR,
    basis: { type: "复核签字", summary: "重复操作" },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "INVALID_STATE");
});

test("确认缺少依据或经办人时返回 400", async (context) => {
  const { api } = await startHarness(context);
  await api.post("/v1/artifacts", registerBody());
  const noBasis = await api.post("/v1/artifacts/artifact-0001/confirm", { operator: OPERATOR });
  assert.equal(noBasis.status, 400);
  const noOperator = await api.post("/v1/artifacts/artifact-0001/confirm", {
    basis: { type: "x", summary: "y" },
  });
  assert.equal(noOperator.status, 400);
});

test("编号解析：有效编号直达身份，旧档编号作废后仍可查到去向", async (context) => {
  const { api } = await startHarness(context);
  await api.post("/v1/artifacts", registerBody());

  const hit = await api.get("/v1/identifiers/resolve?value=SCAN-A9F3");
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.resolved, true);
  assert.equal(hit.body.data.artifactId, "artifact-0001");

  await api.post("/v1/artifacts/artifact-0001/identifiers/void", {
    operator: OPERATOR,
    value: "JIU-001",
    basis: { type: "旧档勘误", summary: "旧纸档编号系抄录错误，作废并保留痕迹", documentRef: "ERR-031" },
  });
  const gone = await api.get("/v1/identifiers/resolve?value=JIU-001");
  assert.equal(gone.status, 200);
  assert.equal(gone.body.data.resolved, false);
  assert.equal(gone.body.data.history[0].status, "voided");
});

test("补挂已属于别的身份的编号返回占用方信息", async (context) => {
  const { api } = await startHarness(context);
  await api.post("/v1/artifacts", registerBody());
  await api.post(
    "/v1/artifacts",
    registerBody({
      identifiers: [{ value: "OTHER-1", system: "temporary" }],
      basicInfo: { name: "陶罐" },
    }),
  );
  const conflict = await api.post("/v1/artifacts/artifact-0002/identifiers", {
    operator: OPERATOR,
    basis: { type: "核对", summary: "尝试补挂" },
    identifier: { value: "SCAN-A9F3", system: "warehouse-scan" },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.details.ownerArtifactId, "artifact-0001");
});
