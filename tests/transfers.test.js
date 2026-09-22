import assert from "node:assert/strict";
import test from "node:test";
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

test("出库移交：生成清单指纹，在途与交讫状态可追踪", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerConfirmed(api);

  const initiated = await api.post("/v1/transfers/outbound", {
    operator: OPERATOR,
    toInstitution: "邻市博物馆",
    toContact: "陈保管",
    artifactIds: [id],
    basis: { type: "馆际交流协议", summary: "赴邻市参加联展", documentRef: "AGR-2026-18" },
  });
  assert.equal(initiated.status, 200);
  const transferId = initiated.body.data.transfer.transferId;
  const fingerprint = initiated.body.data.manifestFingerprint;
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(initiated.body.data.transfer.status, "pending");

  let detail = await api.get("/v1/artifacts/" + id);
  assert.equal(detail.body.data.custody, "in-transit");

  const confirmed = await api.post("/v1/transfers/" + transferId + "/confirm", {
    operator: OPERATOR,
    receivedBy: "邻市博物馆 陈保管",
    receiptRef: "RCPT-2026-09-22-07",
    basis: { type: "签收回单", summary: "对方验收无误并回签" },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.transfer.status, "completed");

  detail = await api.get("/v1/artifacts/" + id);
  assert.equal(detail.body.data.custody, "external");
  assert.equal(detail.body.data.currentLocation, "邻市博物馆");
  assert.deepEqual(detail.body.data.outboundTransfers, [transferId]);
});

test("器物在出借中不能移交，阻止原因返回占用单号", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerConfirmed(api);
  await api.post("/v1/artifacts/" + id + "/usages", {
    operator: OPERATOR,
    usageType: "loan",
    ref: "LOAN-99",
    basis: { type: "出借单", summary: "尚在外展" },
  });
  const res = await api.post("/v1/transfers/outbound", {
    operator: OPERATOR,
    toInstitution: "邻市博物馆",
    artifactIds: [id],
    basis: { type: "协议", summary: "试图移交" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "TRANSFER_BLOCKED");
  assert.equal(res.body.error.details.blockers[0].usages[0].ref, "LOAN-99");
});

test("入库移交：整批建档并用对方指纹核对，形成可核对链路", async (context) => {
  const { api } = await startHarness(context);

  // 第一步由对方（或随件单据）提供清单指纹，本馆按实物点收整批入库。
  const inbound = await api.post("/v1/transfers/inbound", {
    operator: OPERATOR,
    batchId: "batch-in-2026-0922",
    fromInstitution: "省考古研究院",
    externalTransferId: "SKS-TRF-2026-77",
    manifestFingerprint: "f1a2b3c4d5e600000000000000000000000000000000000000000000000000aa",
    basis: { type: "考古移交目录", summary: "省考古院 2026 年度第三批移交", documentRef: "SKS-2026-03" },
    artifacts: [
      {
        basicInfo: { name: "灰陶仓楼", category: "陶器", dynasty: "汉" },
        excavation: { site: "北塬汉墓群", location: "M12 前室" },
        photoIds: ["photo-in-001"],
        location: { code: "C-03-01" },
        identifiers: [
          { value: "SKS-J-301", system: "external", note: "省考古院编号" },
          { value: "SCAN-IN-7701", system: "warehouse-scan" },
        ],
      },
      {
        basicInfo: { name: "铁削刀", category: "铁器", dynasty: "汉" },
        location: { code: "C-03-02" },
        identifiers: [{ value: "SKS-J-302", system: "external" }],
      },
    ],
  });
  assert.equal(inbound.status, 200);
  const transferId = inbound.body.data.inboundTransferId;
  assert.equal(inbound.body.data.artifactIds.length, 2);

  // 指纹核对：一致与不一致都有明确结论。
  const match = await api.post("/v1/transfers/" + transferId + "/verify-manifest", {
    fingerprint: "f1a2b3c4d5e600000000000000000000000000000000000000000000000000aa",
  });
  assert.equal(match.body.data.matches, true);
  const mismatch = await api.post("/v1/transfers/" + transferId + "/verify-manifest", {
    fingerprint: "deadbeef",
  });
  assert.equal(mismatch.body.data.matches, false);

  // 入库器物的来源链路指回该移交单。
  const artifactId = inbound.body.data.artifactIds[0];
  const detail = await api.get("/v1/artifacts/" + artifactId);
  assert.equal(detail.body.data.inboundTransferId, transferId);
  assert.equal(detail.body.data.provenance[0].detail.fromInstitution, "省考古研究院");
  assert.equal(detail.body.data.status, "draft");

  const batch = await api.get("/v1/batches/batch-in-2026-0922");
  assert.equal(batch.body.data.artifacts.length, 2);
});

test("入库清单编号与本馆既有身份冲突时整批拒绝，不产生半批数据", async (context) => {
  const { api } = await startHarness(context);
  await registerConfirmed(api, { identifiers: [{ value: "SKS-J-301", system: "external" }] });

  const inbound = await api.post("/v1/transfers/inbound", {
    operator: OPERATOR,
    fromInstitution: "省考古研究院",
    manifestFingerprint: "abc",
    basis: { type: "目录", summary: "问题批次" },
    artifacts: [
      {
        basicInfo: { name: "灰陶仓楼" },
        identifiers: [{ value: "SKS-J-301", system: "external" }],
      },
      {
        basicInfo: { name: "铁削刀" },
        identifiers: [{ value: "SKS-J-302", system: "external" }],
      },
    ],
  });
  assert.equal(inbound.status, 409);
  assert.equal(inbound.body.error.code, "IDENTIFIER_CONFLICT");
  const transfers = await api.get("/v1/transfers");
  assert.equal(transfers.body.data.transfers.length, 0);
});
