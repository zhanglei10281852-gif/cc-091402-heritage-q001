import assert from "node:assert/strict";
import test from "node:test";
import { HeritageService } from "../src/services/heritage-service.js";
import { tempDataDir } from "./helpers.js";

const ADMIN = { id: "u1", name: "王管理员", role: "管理员" };
const CURATOR = { id: "u2", name: "李保护", role: "保护人员" };
const BASIS = { document: "复核勘误单", documentId: "KW-2026-03" };

function newService() {
  const svc = new HeritageService({ dataDir: tempDataDir() });
  svc.start();
  return svc;
}

async function setupRegistered(svc, { name = "青釉瓷碗", numbers } = {}) {
  const { batch } = await svc.openBatch({ actor: ADMIN, note: "批次" });
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name, category: "瓷器", dynasty: "南宋" },
    excavation: { site: "龙泉窑遗址" },
    numbers: numbers ?? [{ number: "JD-1", namespace: "旧纸档" }],
  });
  await svc.registerArtifact(artifact.id, { actor: ADMIN });
  return artifact.id;
}

test("每次信息更正都保留字段、原因、依据与经办人，且不改写历史", async () => {
  const svc = newService();
  const id = await setupRegistered(svc);
  await svc.correctInfo(id, {
    actor: CURATOR,
    reason: "新出土纪年材料证明年代应为北宋",
    basis: BASIS,
    info: { dynasty: "北宋" },
  });

  const view = svc.getArtifactView(id);
  assert.equal(view.info.dynasty, "北宋");
  const correction = view.provenance.find((p) => p.kind === "info_corrected");
  assert.ok(correction);
  assert.equal(correction.actor.id, "u2");
  assert.equal(correction.basis.documentId, "KW-2026-03");

  const { events } = svc.historyOfArtifact(id);
  const correctedEvent = events.find((e) => e.type === "artifact_info_corrected");
  assert.deepEqual(correctedEvent.data.fields.info, { dynasty: "北宋" });
  // 旧值不出现在当前状态，但事件本身不可变。
  const createdEvent = events.find((e) => e.type === "artifact_created");
  assert.equal(createdEvent.data.info.dynasty, "南宋");
});

test("鉴定意见形成版本链：新版生效、旧版标记 superseded、更正挂在原版本上", async () => {
  const svc = newService();
  const id = await setupRegistered(svc);
  const a1 = await svc.addAuthentication(id, {
    actor: CURATOR,
    authentication: { authenticator: "张鉴定", opinion: "南宋龙泉窑", confidence: "中" },
  });
  const v1Id = a1.artifact.authentications.currentId;

  const a2 = await svc.addAuthentication(id, {
    actor: CURATOR,
    authentication: { authenticator: "张鉴定", organization: "省文物鉴定站", opinion: "北宋早期龙泉窑", confidence: "高" },
  });
  const v2Id = a2.artifact.authentications.currentId;
  assert.notEqual(v1Id, v2Id);
  const v1 = a2.artifact.authentications.versions.find((x) => x.id === v1Id);
  assert.equal(v1.status, "superseded");

  await svc.correctAuthentication(id, v2Id, {
    actor: ADMIN,
    reason: "誊写错误",
    basis: { note: "鉴定站电话确认" },
    fields: { opinion: "北宋中晚期龙泉窑" },
  });
  const view = svc.getArtifactView(id);
  const v2 = view.authentications.versions.find((x) => x.id === v2Id);
  assert.equal(v2.opinion, "北宋中晚期龙泉窑");
  assert.equal(v2.corrections[0].reason, "誊写错误");
  assert.equal(v2.corrections[0].by.id, "u1");
});

test("撤销只允许针对草稿；已登记器物不能撤销，只能走更正/合并流程", async () => {
  const svc = newService();
  const { batch } = await svc.openBatch({ actor: ADMIN });
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "残片", category: "其他" },
    numbers: [{ number: "CP-1", namespace: "临时清单" }],
  });
  const { artifact: voided } = await svc.voidDraft(artifact.id, {
    actor: ADMIN,
    reason: "核查为现代仿品残片，不入库",
    basis: { document: "拒收记录", documentId: "JS-1" },
  });
  assert.equal(voided.status, "voided");
  assert.throws(() => svc.resolveNumber("CP-1"), (e) => e.code === "not_found");

  const registeredId = await setupRegistered(svc, { name: "另一件" });
  await assert.rejects(
    svc.voidDraft(registeredId, { actor: ADMIN, reason: "x", basis: BASIS }),
    (e) => e.code === "precondition_failed",
  );
});

test("草稿一旦用于出借或展览（先登记）便不能被撤销；在借在展阻断合并", async () => {
  const svc = newService();
  const id = await setupRegistered(svc);
  await svc.openLoan(id, {
    actor: ADMIN,
    borrower: "市美术馆",
    loanNo: "J-2026-09",
  });

  // 已登记器物本就不能撤销；此处验证在借状态会进入冲突原因。
  const other = await setupRegistered(svc, { name: "瓷瓶", numbers: [{ number: "JD-2", namespace: "旧纸档" }] });
  await assert.rejects(
    svc.mergeArtifacts({
      actor: ADMIN,
      artifactIds: [id, other],
      survivorId: id,
      reason: "经核对为同组器物",
      basis: BASIS,
    }),
    (e) =>
      e.code === "conflict" &&
      e.details.reasons.some((r) => r.type === "artifact_on_loan") &&
      e.details.reasons[0].loanId.startsWith("loan_"),
  );

  // 归还后合并成功。
  const loanId = svc.getArtifactView(id).activeLoanIds[0];
  await svc.returnLoan(loanId, { actor: ADMIN });
  const merged = await svc.mergeArtifacts({
    actor: ADMIN,
    artifactIds: [id, other],
    survivorId: id,
    reason: "经核对为同组器物",
    basis: BASIS,
  });
  assert.equal(merged.artifact.status, "registered");
  assert.deepEqual(merged.merged, [other]);
});

test("合并后被并身份终止但旧编号全部解析到幸存身份，谱系双向可查", async () => {
  const svc = newService();
  const idA = await setupRegistered(svc, { name: "瓷碗", numbers: [{ number: "A-1", namespace: "旧纸档" }] });
  const idB = await setupRegistered(svc, {
    name: "瓷碗（重复建档）",
    numbers: [
      { number: "B-9", namespace: "临时清单" },
      { number: "S-2", namespace: "库房扫描" },
    ],
  });

  await svc.mergeArtifacts({
    actor: ADMIN,
    artifactIds: [idA, idB],
    survivorId: idA,
    reason: "三套编号指向同一器物",
    basis: { document: "编号核对会议纪要", documentId: "HD-2" },
  });

  assert.equal(svc.resolveNumber("A-1").resolution.artifactId, idA);
  assert.equal(svc.resolveNumber("B-9").resolution.artifactId, idA);
  assert.equal(svc.resolveNumber("S-2").resolution.artifactId, idA);
  const survivor = svc.getArtifactView(idA);
  const inherited = survivor.numbers.aliases.filter((a) => a.mergedFrom === idB);
  assert.equal(inherited.length, 2);
  assert.equal(svc.getArtifactView(idB).status, "merged");
  assert.equal(svc.getArtifactView(idB).lineage.merge.into, idA);
});

test("拆分产生新批次下的子件草稿，父件终止并保留子件清单，子件可重新登记", async () => {
  const svc = newService();
  const parentId = await setupRegistered(svc, {
    name: "成套瓷俑",
    numbers: [{ number: "T-100", namespace: "库房扫描" }],
  });
  const result = await svc.splitArtifact(parentId, {
    actor: ADMIN,
    reason: "入库后确认实为两件独立器物粘连登记",
    basis: { document: "拆验记录", documentId: "CY-5" },
    children: [
      { info: { name: "文官俑", category: "陶俑" }, numbers: [{ number: "T-101", namespace: "库房扫描" }] },
      { info: { name: "武士俑", category: "陶俑" }, numbers: [{ number: "T-102", namespace: "库房扫描" }] },
    ],
  });

  assert.equal(result.children.length, 2);
  assert.equal(svc.getArtifactView(parentId).status, "split");
  assert.throws(() => svc.resolveNumber("T-100"), (e) => e.code === "not_found");
  for (const child of result.children) {
    assert.equal(child.status, "draft");
    assert.equal(child.lineage.split.parentId, parentId);
    await svc.registerArtifact(child.id, { actor: ADMIN });
  }
  assert.equal(svc.resolveNumber("T-101").resolution.status, "registered");
  const batchView = svc.getBatch(result.batchId);
  assert.deepEqual(batchView.artifacts.map((a) => a.status), ["registered", "registered"]);
});

test("在展器物不能合并或移交，撤展后恢复", async () => {
  const svc = newService();
  const id = await setupRegistered(svc);
  const { exhibition } = await svc.openExhibition(id, {
    actor: ADMIN,
    name: "宋韵特展",
    venue: "市博物馆一楼临展厅",
  });
  const other = await setupRegistered(svc, { name: "瓷碟", numbers: [{ number: "D-1", namespace: "旧纸档" }] });
  await assert.rejects(
    svc.mergeArtifacts({
      actor: ADMIN,
      artifactIds: [id, other],
      survivorId: id,
      reason: "同组",
      basis: BASIS,
    }),
    (e) => e.details.reasons.some((r) => r.type === "artifact_on_exhibition"),
  );
  await svc.closeExhibition(exhibition.id, { actor: ADMIN });
  const merged = await svc.mergeArtifacts({
    actor: ADMIN,
    artifactIds: [id, other],
    survivorId: id,
    reason: "同组",
    basis: BASIS,
  });
  assert.equal(merged.artifact.id, id);
});
