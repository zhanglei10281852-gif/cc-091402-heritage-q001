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

test("未用于出借或展览的草稿可以撤销，编号随之释放", async (context) => {
  const { api } = await startHarness(context);
  const res = await api.post("/v1/artifacts", registerBody());
  const id = res.body.data.artifactId;
  const withdrawn = await api.post("/v1/artifacts/" + id + "/withdraw", {
    operator: OPERATOR,
    basis: { type: "录入勘误", summary: "发现器物与移交批次不符，撤销草稿", documentRef: "ERR-040" },
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.data.status, "withdrawn");

  // 编号已释放：同一编号可重新登记为新身份。
  const reRegister = await api.post("/v1/artifacts", registerBody());
  assert.equal(reRegister.status, 200);
  assert.equal(reRegister.body.data.artifactId, "artifact-0002");

  // 撤销事件仍可审计，依据与经办人保留。
  const history = await api.get("/v1/artifacts/" + id + "/history");
  assert.ok(history.body.data.events.some((e) => e.type === "ArtifactWithdrawn"));
});

test("已确认登记不能撤销；已用于展览的草稿也不能撤销", async (context) => {
  const { api } = await startHarness(context);

  const confirmedId = await registerConfirmed(api);
  const rejected = await api.post("/v1/artifacts/" + confirmedId + "/withdraw", {
    operator: OPERATOR,
    basis: { type: "x", summary: "正式登记不应被撤销" },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, "WITHDRAW_DRAFT_ONLY");

  const draft = await api.post(
    "/v1/artifacts",
    registerBody({ identifiers: [{ value: "PLAN-9", system: "temporary" }], basicInfo: { name: "拟展器物" } }),
  );
  const draftId = draft.body.data.artifactId;
  const usage = await api.post("/v1/artifacts/" + draftId + "/usages", {
    operator: OPERATOR,
    usageType: "exhibition",
    ref: "EXH-2026-11",
    basis: { type: "展览立项", summary: "已纳入国庆特展清单" },
  });
  assert.equal(usage.status, 200);

  const blocked = await api.post("/v1/artifacts/" + draftId + "/withdraw", {
    operator: OPERATOR,
    basis: { type: "x", summary: "试图撤销" },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "ARTIFACT_IN_USE");
  assert.equal(blocked.body.error.details.usages[0].ref, "EXH-2026-11");
});

test("合并：重复登记的两个身份并为一个，旧编号与鉴定意见全部并入存续身份", async (context) => {
  const { api } = await startHarness(context);
  const a = await registerConfirmed(api, {
    identifiers: [
      { value: "JIU-001", system: "paper-legacy" },
      { value: "SCAN-A9F3", system: "warehouse-scan" },
    ],
  });
  const b = await registerConfirmed(api, {
    basicInfo: { name: "青釉瓷碗(临时清单误登)" },
    identifiers: [{ value: "LIN-2026-17", system: "interim-list" }],
  });

  await api.post("/v1/artifacts/" + b + "/appraisals", {
    operator: { id: "u-101", name: "王专家" },
    summary: "临时清单登记时的鉴定：宋代青白瓷",
    appraiser: { name: "王专家" },
  });

  const merge = await api.post("/v1/artifacts/merge", {
    operator: OPERATOR,
    survivorId: a,
    sourceIds: [b],
    basis: { type: "编号比对结论", summary: "三源编号经实物比对确认为同一件器物", documentRef: "MRG-007" },
    note: "保留a身份，b并入",
  });
  assert.equal(merge.status, 200);

  const survivor = await api.get("/v1/artifacts/" + a);
  const values = survivor.body.data.identifiers.map((item) => item.value).sort();
  assert.deepEqual(values, ["JIU-001", "LIN-2026-17", "SCAN-A9F3"]);
  assert.ok(survivor.body.data.appraisals.some((item) => item.mergedFrom === b));

  const source = await api.get("/v1/artifacts/" + b);
  assert.equal(source.body.data.status, "merged");
  assert.equal(source.body.data.lineage.mergedInto, a);

  // 谱系图可还原合并关系。
  const lineage = await api.get("/v1/artifacts/" + a + "/lineage");
  assert.ok(lineage.body.data.edges.some((edge) => edge.from === b && edge.to === a && edge.relation === "merged-into"));

  // 被合并身份不能再更正。
  const noCorrect = await api.patch("/v1/artifacts/" + b + "/corrections", {
    operator: OPERATOR,
    basis: { type: "x", summary: "y" },
    patch: { basicInfo: { name: "z" } },
  });
  assert.equal(noCorrect.status, 409);
});

test("存在未结束出借的器物不能合并，冲突原因逐条列出", async (context) => {
  const { api } = await startHarness(context);
  const a = await registerConfirmed(api, { identifiers: [{ value: "A-1", system: "temporary" }] });
  const b = await registerConfirmed(api, {
    identifiers: [{ value: "B-1", system: "temporary" }],
    basicInfo: { name: "另一件" },
  });
  await api.post("/v1/artifacts/" + b + "/usages", {
    operator: OPERATOR,
    usageType: "loan",
    ref: "LOAN-2026-5",
    basis: { type: "出借单", summary: "赴外借展" },
  });
  const merge = await api.post("/v1/artifacts/merge", {
    operator: OPERATOR,
    survivorId: a,
    sourceIds: [b],
    basis: { type: "x", summary: "y" },
  });
  assert.equal(merge.status, 409);
  assert.equal(merge.body.error.code, "MERGE_BLOCKED");
  assert.ok(merge.body.error.details.blockers.some((item) => /出借|展览/.test(item.reason)));
});

test("拆分：一件器物拆为两件独立身份，父子谱系双向可查", async (context) => {
  const { api } = await startHarness(context);
  const parent = await registerConfirmed(api, { identifiers: [{ value: "PARENT-1", system: "accession" }] });
  const split = await api.post("/v1/artifacts/" + parent + "/splits", {
    operator: OPERATOR,
    basis: { type: "保护修复记录", summary: "套器分离登记：碗与盖分别建档", documentRef: "SPL-002" },
    note: "经修复确认实为两件",
    children: [
      {
        basicInfo: { name: "青釉碗身" },
        identifiers: [{ value: "CHILD-BODY", system: "accession" }],
        location: { code: "A-02-01" },
      },
      {
        basicInfo: { name: "青釉碗盖" },
        identifiers: [{ value: "CHILD-LID", system: "accession" }],
        location: { code: "A-02-02" },
      },
    ],
  });
  assert.equal(split.status, 200);
  assert.equal(split.body.data.childIds.length, 2);

  const parentView = await api.get("/v1/artifacts/" + parent);
  assert.equal(parentView.body.data.status, "split");

  const childId = split.body.data.childIds[0];
  const lineage = await api.get("/v1/artifacts/" + childId + "/lineage");
  assert.ok(lineage.body.data.edges.some((edge) => edge.from === parent && edge.relation === "split-into"));

  // 拆分子身份编号冲突时整笔失败。
  const another = await registerConfirmed(api, { identifiers: [{ value: "X-1", system: "temporary" }], basicInfo: { name: "丙" } });
  const badSplit = await api.post("/v1/artifacts/" + another + "/splits", {
    operator: OPERATOR,
    basis: { type: "x", summary: "y" },
    children: [
      { basicInfo: { name: "丙-1" }, identifiers: [{ value: "CHILD-BODY", system: "accession" }] },
    ],
  });
  assert.equal(badSplit.status, 409);
  assert.equal(badSplit.body.error.code, "IDENTIFIER_CONFLICT");
});
