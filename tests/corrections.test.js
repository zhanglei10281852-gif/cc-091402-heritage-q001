import assert from "node:assert/strict";
import test from "node:test";
import { startHarness, registerBody, OPERATOR, APPRAISER } from "./helpers/harness.js";

async function registerAndConfirm(api, overrides) {
  const res = await api.post("/v1/artifacts", registerBody(overrides));
  const id = res.body.data.artifactId;
  await api.post("/v1/artifacts/" + id + "/confirm", {
    operator: OPERATOR,
    basis: { type: "复核签字", summary: "三源编号核对一致" },
  });
  return id;
}

test("更正基本信息与出土地点：保留依据、经办人，且不覆盖未提及字段", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerAndConfirm(api);
  const correction = await api.patch("/v1/artifacts/" + id + "/corrections", {
    operator: { id: "u-002", name: "赵复核", role: "管理员" },
    basis: { type: "考古报告勘误", summary: "探方层数由3层更正为4层", documentRef: "RPT-2026-12" },
    patch: {
      basicInfo: { dynasty: "北宋" },
      excavation: { location: "T2探方第4层" },
      addPhotoIds: ["photo-b-009"],
    },
  });
  assert.equal(correction.status, 200);
  const artifact = correction.body.data.artifact;
  assert.equal(artifact.basicInfo.dynasty, "北宋");
  assert.equal(artifact.basicInfo.name, "青釉瓷碗"); // 未提及字段保留
  assert.equal(artifact.excavation.location, "T2探方第4层");
  assert.equal(artifact.excavation.site, "东郊遗址");
  assert.ok(artifact.photoIds.includes("photo-b-009"));
  assert.equal(artifact.correctionCount, 1);

  const history = await api.get("/v1/artifacts/" + id + "/history");
  const event = history.body.data.events.find((item) => item.type === "InformationCorrected");
  assert.equal(event.basis.documentRef, "RPT-2026-12");
  assert.equal(event.operator.name, "赵复核");
});

test("缺少依据的更正被拒绝", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerAndConfirm(api);
  const res = await api.patch("/v1/artifacts/" + id + "/corrections", {
    operator: OPERATOR,
    patch: { basicInfo: { dynasty: "唐" } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

test("鉴定意见形成版本序列，撤回保留痕迹且版本号不复用", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerAndConfirm(api);

  const v1 = await api.post("/v1/artifacts/" + id + "/appraisals", {
    operator: APPRAISER,
    summary: "初步判定为南宋影青釉",
    appraiser: { name: "王专家", org: "省文保中心", title: "研究员" },
    opinionRef: "OP-2026-001",
  });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.data.appraisal.version, 1);

  const v2 = await api.post("/v1/artifacts/" + id + "/appraisals", {
    operator: APPRAISER,
    summary: "复核后改判为北宋早期青白瓷",
    appraiser: { name: "王专家", org: "省文保中心" },
  });
  assert.equal(v2.body.data.appraisal.version, 2);

  const retract = await api.post(
    "/v1/artifacts/" + id + "/appraisals/" + v1.body.data.appraisal.id + "/retract",
    { operator: OPERATOR, basis: { type: "鉴定复议", summary: "v1结论已被v2替代，按流程撤回" } },
  );
  assert.equal(retract.status, 200);

  const dupVersion = await api.post("/v1/artifacts/" + id + "/appraisals", {
    operator: APPRAISER,
    version: 1,
    summary: "试图复用版本号",
    appraiser: { name: "王专家" },
  });
  assert.equal(dupVersion.status, 409);
  assert.equal(dupVersion.body.error.code, "APPRAISAL_VERSION_EXISTS");

  const detail = await api.get("/v1/artifacts/" + id);
  const statuses = detail.body.data.appraisals.map((item) => item.status).sort();
  assert.deepEqual(statuses, ["active", "retracted"]);
});

test("库位移动形成完整轨迹", async (context) => {
  const { api } = await startHarness(context);
  const id = await registerAndConfirm(api, { location: { code: "A-01-03" } });
  const moved = await api.post("/v1/artifacts/" + id + "/location-moves", {
    operator: OPERATOR,
    location: { code: "B-02-11", note: "布展周转库" },
    basis: { type: "库位调拨单", summary: "筹备宋代生活展" },
  });
  assert.equal(moved.status, 200);
  const detail = await api.get("/v1/artifacts/" + id);
  assert.equal(detail.body.data.currentLocation.code, "B-02-11");
  assert.equal(detail.body.data.locationHistory.length, 2);
});
