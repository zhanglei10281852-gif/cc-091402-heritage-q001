import assert from "node:assert/strict";
import test from "node:test";
import { HeritageService } from "../src/services/heritage-service.js";
import { tempDataDir } from "./helpers.js";

const ADMIN = { id: "u1", name: "王管理员", role: "管理员" };
const BASIS = { document: "2026 秋季考古移交清册", documentId: "KG-2026-017" };

function newService() {
  const svc = new HeritageService({ dataDir: tempDataDir() });
  svc.start();
  return svc;
}

async function openBatch(svc, note = "测试批次") {
  const { batch } = await svc.openBatch({ actor: ADMIN, note });
  return batch;
}

const bowlNumbers = [
  { number: "JD-2026-001", namespace: "旧纸档" },
  { number: "LS-77", namespace: "临时清单" },
  { number: "SCAN-88", namespace: "库房扫描" },
];

test("器物建立后获得不可变身份，三个来源编号进入待核验", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "青釉瓷碗", category: "瓷器", dynasty: "北宋" },
    excavation: { site: "龙泉窑遗址", location: "三号窑炉 Y3" },
    numbers: bowlNumbers,
  });

  assert.equal(artifact.status, "draft");
  assert.match(artifact.id, /^artifact-\d{4}$/);
  assert.equal(artifact.immutableIdentity.createdBy.id, "u1");
  assert.equal(artifact.numbers.pending.length, 3);
  assert.equal(artifact.numbers.aliases.length, 0);
});

test("同批次并发录入相同编号只会成功一件，其余返回结构化冲突原因", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  const payload = (name) => ({
    actor: ADMIN,
    batchId: batch.id,
    info: { name, category: "陶器" },
    numbers: [{ number: "JD-2026-001", namespace: "旧纸档" }],
  });

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      svc.createArtifact(payload(`并发陶罐 ${i}`)),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 7);
  for (const r of rejected) {
    assert.equal(r.reason.code, "conflict");
    assert.equal(r.reason.status, 409);
    const types = r.reason.details.reasons.map((x) => x.type);
    assert.ok(
      types.includes("number_held_by_draft") || types.includes("number_already_registered"),
      `冲突原因必须指出编号占用方，实际：${types}`,
    );
    const reason = r.reason.details.reasons.find(
      (x) => x.type === "number_held_by_draft" || x.type === "number_already_registered",
    );
    assert.ok(reason.heldBy, "冲突原因必须给出占用器物");
  }
});

test("编号大小写、全半角与空白差异视为同号软冲突，显式放行后可创建", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "瓷碗甲", category: "瓷器" },
    numbers: [{ number: "JD-001", namespace: "旧纸档" }],
  });

  await assert.rejects(
    svc.createArtifact({
      actor: ADMIN,
      batchId: batch.id,
      info: { name: "瓷碗乙", category: "瓷器" },
      numbers: [{ number: "ｊｄ　001", namespace: "库房扫描" }],
    }),
    (error) => {
      assert.equal(error.code, "conflict");
      assert.ok(error.details.reasons.some((r) => r.type === "number_similar_format"));
      return true;
    },
  );

  const allowed = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "瓷碗乙", category: "瓷器" },
    numbers: [{ number: "SC-9", namespace: "库房扫描" }],
  });
  assert.equal(allowed.artifact.status, "draft");
});

test("编号分隔符差异属于需人工裁决的软冲突：不放行不行，显式放行后可以", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "瓷碗甲", category: "瓷器" },
    numbers: [{ number: "JD-001", namespace: "旧纸档" }],
  });
  const secondPayload = {
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "瓷碗乙", category: "瓷器" },
    numbers: [{ number: "jd - 001", namespace: "库房扫描" }],
  };
  await assert.rejects(svc.createArtifact(secondPayload), (error) => {
    assert.equal(error.code, "conflict");
    assert.ok(error.details.reasons.some((r) => r.type === "number_similar_format"));
    return true;
  });

  const allowed = await svc.createArtifact({ ...secondPayload, allowDuplicates: true });
  assert.equal(allowed.artifact.status, "draft");
  // 两个文本编号各自仍可精确解析到不同器物。
  assert.equal(svc.resolveNumber("JD-001").resolution.artifactId, "artifact-0001");
  assert.equal(svc.resolveNumber("jd - 001").resolution.artifactId, allowed.artifact.id);
});

test("登记后三个编号都解析到同一不可变身份", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "青釉瓷碗", category: "瓷器" },
    numbers: bowlNumbers,
  });
  await svc.registerArtifact(artifact.id, { actor: ADMIN });

  for (const number of ["JD-2026-001", "ls-77", " SCAN-88 "]) {
    const res = svc.resolveNumber(number);
    assert.equal(res.resolution.kind, "registered");
    assert.equal(res.resolution.artifactId, artifact.id);
  }
  assert.equal(svc.getArtifactView("LS-77").id, artifact.id);
});

test("重启服务后当前状态、编号解析与历史完整还原", async () => {
  const dir = tempDataDir();
  const svc = new HeritageService({ dataDir: dir });
  svc.start();
  const { batch } = await svc.openBatch({ actor: ADMIN, note: "持久化批次" });
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "青铜鼎", category: "青铜器" },
    excavation: { site: "殷墟" },
    numbers: [{ number: "QT-1", namespace: "库房扫描" }],
  });
  await svc.registerArtifact(artifact.id, { actor: ADMIN });
  const headBefore = svc.headHash();

  const restarted = new HeritageService({ dataDir: dir });
  const info = restarted.start();
  assert.equal(info.verified, true);
  assert.equal(restarted.headHash(), headBefore);
  const view = restarted.getArtifactView(artifact.id);
  assert.equal(view.status, "registered");
  assert.equal(restarted.resolveNumber("QT-1").resolution.artifactId, artifact.id);
  const { events } = restarted.historyOfArtifact(artifact.id);
  assert.ok(events.length >= 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ["artifact_created", "artifact_registered"],
  );
});

test("封存批次时若仍有草稿则拒绝，全部登记后可封存", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "陶俑", category: "陶器" },
    numbers: [{ number: "TY-2", namespace: "临时清单" }],
  });
  await assert.rejects(
    svc.sealBatch(batch.id, { actor: ADMIN }),
    (e) => e.code === "precondition_failed" && e.details.draftArtifactIds.includes(artifact.id),
  );
  await svc.registerArtifact(artifact.id, { actor: ADMIN });
  const { batch: sealed } = await svc.sealBatch(batch.id, { actor: ADMIN });
  assert.equal(sealed.status, "sealed");

  await assert.rejects(
    svc.createArtifact({
      actor: ADMIN,
      batchId: batch.id,
      info: { name: "补录物", category: "其他" },
      numbers: [{ number: "X-1", namespace: "其他" }],
    }),
    (e) => e.code === "precondition_failed",
  );
});

test("缺少经办人或依据的写入被拒绝", async () => {
  const svc = newService();
  const batch = await openBatch(svc);
  await assert.rejects(
    svc.createArtifact({
      batchId: batch.id,
      info: { name: "无主物", category: "其他" },
      numbers: [{ number: "X-2", namespace: "其他" }],
    }),
    (e) => e.code === "validation_error",
  );
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "陶俑", category: "陶器" },
    numbers: [{ number: "TY-9", namespace: "临时清单" }],
  });
  await assert.rejects(
    svc.voidDraft(artifact.id, { actor: ADMIN, reason: "重复录入" }),
    (e) =>
      e.code === "validation_error" &&
      e.details.details.some((d) => d.field === "basis"),
  );
});
