import assert from "node:assert/strict";
import test from "node:test";
import { HeritageService } from "../src/services/heritage-service.js";
import { tempDataDir } from "./helpers.js";

const ADMIN = { id: "u1", name: "王管理员", role: "管理员" };

function newService() {
  const svc = new HeritageService({ dataDir: tempDataDir() });
  svc.start();
  return svc;
}

async function createDraft(svc, number) {
  const { batch } = await svc.openBatch({ actor: ADMIN, note: "编号生命周期" });
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name: "陶盏", category: "陶器" },
    numbers: [{ number, namespace: "旧纸档" }],
  });
  return artifact;
}

test("草稿期补录编号进入待核验，移除后占用立即释放可被他人使用", async () => {
  const svc = newService();
  const draft = await createDraft(svc, "OLD-1");

  const added = await svc.linkNumber(draft.id, {
    actor: ADMIN,
    number: { number: "SCAN-500", namespace: "库房扫描" },
    basis: { document: "扫描回执", documentId: "SM-500" },
  });
  assert.equal(added.artifact.numbers.pending.length, 2);
  assert.equal(added.artifact.numbers.aliases.length, 0);

  // 被草稿占用期间，其他器物不能使用同一编号。
  await assert.rejects(
    (async () => {
      const other = await createDraft(svc, "OTHER-1");
      return svc.linkNumber(other.id, {
        actor: ADMIN,
        number: { number: "scan500", namespace: "库房扫描" },
        basis: { note: "x" },
      });
    })(),
    (e) => e.code === "conflict",
  );

  await svc.unlinkNumber(draft.id, {
    actor: ADMIN,
    number: "SCAN-500",
    reason: "扫描号张冠李戴，录入有误",
    basis: { document: "扫描回执", documentId: "SM-500" },
  });
  assert.equal(svc.getArtifactView(draft.id).numbers.pending.length, 1);
  assert.throws(() => svc.resolveNumber("SCAN-500"), (e) => e.code === "not_found");
});

test("草稿登记后，补录的正式编号成为别名并可解除（需依据且无在途业务）", async () => {
  const svc = newService();
  const draft = await createDraft(svc, "OLD-2");
  await svc.registerArtifact(draft.id, { actor: ADMIN });
  await svc.linkNumber(draft.id, {
    actor: ADMIN,
    number: { number: "NEW-2", namespace: "库房扫描" },
    basis: { note: "库房重新编码" },
  });
  assert.equal(svc.resolveNumber("NEW-2").resolution.artifactId, draft.id);

  await assert.rejects(
    svc.unlinkNumber(draft.id, { actor: ADMIN, number: "NEW-2", reason: "x" }),
    (e) =>
      e.code === "validation_error" &&
      e.details.details.some((d) => d.field === "basis"),
  );

  await svc.unlinkNumber(draft.id, {
    actor: ADMIN,
    number: "NEW-2",
    reason: "编码规则更换",
    basis: { document: "编码调整通知", documentId: "BM-1" },
  });
  assert.throws(() => svc.resolveNumber("NEW-2"), (e) => e.code === "not_found");
  // 解除后编号历史仍保留为 superseded 别名。
  const alias = svc
    .getArtifactView(draft.id)
    .numbers.aliases.find((a) => a.number === "NEW-2");
  assert.equal(alias.status, "superseded");
  assert.equal(alias.unlinkReason, "编码规则更换");
});

test("审计时间范围与非法 limit", async () => {
  const svc = newService();
  await createDraft(svc, "OLD-3");
  const all = svc.audit({});
  assert.ok(all.count >= 2);
  const future = svc.audit({ from: "2999-01-01T00:00:00Z" });
  assert.equal(future.count, 0);
  assert.throws(
    () => svc.audit({ limit: "abc" }),
    (e) => e.code === "validation_error",
  );
  assert.throws(
    () => svc.audit({ from: "not-a-date" }),
    (e) => e.code === "validation_error",
  );
});

test("照片索引与库位样例可写入并随器物返回", async () => {
  const svc = newService();
  const draft = await createDraft(svc, "OLD-4");
  await svc.registerArtifact(draft.id, { actor: ADMIN });
  await svc.updateStorage(draft.id, {
    actor: ADMIN,
    storage: { location: "一号库房 A 区", shelfCode: "A-12-03", note: "锦盒存放" },
  });
  await svc.updatePhotos(draft.id, {
    actor: ADMIN,
    photos: [
      { photoId: "P-0001", uri: "photos/2026/09/P-0001.jpg", caption: "正面" },
      { photoId: "P-0002", uri: "photos/2026/09/P-0002.jpg", caption: "底部款识" },
    ],
  });
  const view = svc.getArtifactView(draft.id);
  assert.equal(view.storage.shelfCode, "A-12-03");
  assert.equal(view.photos.length, 2);
  assert.equal(view.photos[1].indexedBy.id, "u1");
});
