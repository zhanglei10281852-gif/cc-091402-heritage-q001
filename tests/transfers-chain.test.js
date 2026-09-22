import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeritageService } from "../src/services/heritage-service.js";
import { EventStore } from "../src/store/event-store.js";
import { tempDataDir } from "./helpers.js";

const ADMIN = { id: "u1", name: "王管理员", role: "管理员" };
const RECEIVER = { id: "u9", name: "陈接收", role: "管理员" };
const BASIS = { document: "跨馆调拨令", documentId: "DB-2026-11" };

function newService() {
  const svc = new HeritageService({ dataDir: tempDataDir() });
  svc.start();
  return svc;
}

async function setupArtifact(svc, number = "JD-1", name = "青瓷盏") {
  const { batch } = await svc.openBatch({ actor: ADMIN, note: "移交批次" });
  const { artifact } = await svc.createArtifact({
    actor: ADMIN,
    batchId: batch.id,
    info: { name, category: "瓷器" },
    numbers: [{ number, namespace: "旧纸档" }],
  });
  await svc.registerArtifact(artifact.id, { actor: ADMIN });
  return artifact.id;
}

test("移交完整链路：发起→出库（取得核对码）→凭码签收，器物状态与保管方同步变化", async () => {
  const svc = newService();
  const id = await setupArtifact(svc);
  const { transfer } = await svc.createTransfer({
    actor: ADMIN,
    artifactIds: [id],
    fromOrg: "市博物馆",
    toOrg: "省博物馆",
    reason: "借展调拨",
  });
  const dispatched = await svc.dispatchTransfer(transfer.id, { actor: ADMIN, note: "随押运车出发" });
  assert.match(dispatched.verificationCode, /^evt_/);

  await assert.rejects(
    svc.acceptTransfer(transfer.id, { actor: RECEIVER, verificationCode: "evt_wrong" }),
    (e) =>
      e.code === "conflict" &&
      e.details.reasons[0].type === "verification_code_mismatch" &&
      e.details.reasons[0].expectedEventId === dispatched.verificationCode,
  );

  const { transfer: accepted } = await svc.acceptTransfer(transfer.id, {
    actor: RECEIVER,
    verificationCode: dispatched.verificationCode,
  });
  assert.equal(accepted.status, "accepted");
  const view = svc.getArtifactView(id);
  assert.equal(view.status, "transferred_out");
  assert.equal(view.custody.holder, "省博物馆");
  assert.equal(view.custody.transferId, transfer.id);
});

test("出库后拒收：器物退回移交方，状态恢复已登记，链路时间线完整", async () => {
  const svc = newService();
  const id = await setupArtifact(svc, "JD-7");
  const { transfer } = await svc.createTransfer({
    actor: ADMIN,
    artifactIds: [id],
    fromOrg: "市博物馆",
    toOrg: "临市博物馆",
  });
  const { verificationCode } = await svc.dispatchTransfer(transfer.id, { actor: ADMIN });
  assert.equal(verificationCode.startsWith("evt_"), true);
  const { transfer: rejected } = await svc.rejectTransfer(transfer.id, {
    actor: RECEIVER,
    reason: "外包装破损，器物待复检",
  });
  assert.equal(rejected.status, "rejected");
  const view = svc.getArtifactView(id);
  assert.equal(view.status, "registered");
  assert.equal(view.custody.holder, "市博物馆");
  assert.equal(view.custody.transferId, null);
  const statuses = rejected.timeline.map((t) => t.status);
  assert.deepEqual(statuses, ["proposed", "in_transit", "rejected"]);
});

test("已发起未出库可取消；已出库不能取消", async () => {
  const svc = newService();
  const id = await setupArtifact(svc, "JD-8");
  const { transfer } = await svc.createTransfer({
    actor: ADMIN,
    artifactIds: [id],
    fromOrg: "市博物馆",
    toOrg: "省博物馆",
  });
  const { transfer: cancelled } = await svc.cancelTransfer(transfer.id, {
    actor: ADMIN,
    reason: "调拨计划撤销",
  });
  assert.equal(cancelled.status, "cancelled");

  const id2 = await setupArtifact(svc, "JD-9", "青铜剑");
  const t2 = await svc.createTransfer({
    actor: ADMIN,
    artifactIds: [id2],
    fromOrg: "市博物馆",
    toOrg: "省博物馆",
  });
  await svc.dispatchTransfer(t2.transfer.id, { actor: ADMIN });
  await assert.rejects(
    svc.cancelTransfer(t2.transfer.id, { actor: ADMIN, reason: "x" }),
    (e) => e.code === "precondition_failed",
  );
});

test("在借器物不能发起移交", async () => {
  const svc = newService();
  const id = await setupArtifact(svc, "JD-10");
  await svc.openLoan(id, { actor: ADMIN, borrower: "某展陈中心", loanNo: "J-1" });
  await assert.rejects(
    svc.createTransfer({
      actor: ADMIN,
      artifactIds: [id],
      fromOrg: "市博物馆",
      toOrg: "省博物馆",
    }),
    (e) => e.code === "conflict" && e.details.reasons.some((r) => r.type === "artifact_on_loan"),
  );
});

test("移交核对包可用于跨馆核对，重启后链路完整", async () => {
  const dir = tempDataDir();
  let svc = new HeritageService({ dataDir: dir });
  svc.start();
  const id = await svc.openBatch({ actor: ADMIN }).then(async ({ batch }) => {
    const { artifact } = await svc.createArtifact({
      actor: ADMIN,
      batchId: batch.id,
      info: { name: "青瓷盏", category: "瓷器" },
      numbers: [{ number: "JD-66", namespace: "旧纸档" }],
    });
    await svc.registerArtifact(artifact.id, { actor: ADMIN });
    return artifact.id;
  });
  const { transfer } = await svc.createTransfer({
    actor: ADMIN,
    artifactIds: [id],
    fromOrg: "市博物馆",
    toOrg: "省博物馆",
    reason: "长期调拨",
  });
  const dispatch = await svc.dispatchTransfer(transfer.id, { actor: ADMIN });
  const pkg = svc.transferPackage(transfer.id);
  assert.equal(pkg.verificationCode, dispatch.verificationCode);
  assert.ok(pkg.events.some((e) => e.type === "transfer_created"));
  assert.ok(pkg.events.some((e) => e.type === "transfer_dispatched"));
  assert.equal(pkg.headHash, svc.headHash());
  assert.equal(pkg.artifacts[0].id, id);

  svc = new HeritageService({ dataDir: dir });
  svc.start();
  await svc.acceptTransfer(transfer.id, {
    actor: RECEIVER,
    verificationCode: dispatch.verificationCode,
  });
  const after = svc.getTransferView(transfer.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.verification.code, dispatch.verificationCode);
  assert.equal(after.verification.actor.id, RECEIVER.id);
  // 签收后器物保管方与谱系均落为事件，再次重启仍一致。
  const svc3 = new HeritageService({ dataDir: dir });
  svc3.start();
  assert.equal(svc3.getArtifactView(id).custody.holder, "省博物馆");
  assert.equal(svc3.getTransferView(transfer.id).status, "accepted");
});

test("事件日志被篡改时重启显式报哈希链断裂", async () => {
  const dir = tempDataDir();
  const svc = new HeritageService({ dataDir: dir });
  svc.start();
  const logPath = join(dir, "events.log");
  await svc.openBatch({ actor: ADMIN, note: "x" });
  const original = readFileSync(logPath, "utf8");
  const line = JSON.parse(original);
  line.data.note = "被篡改的说明";
  writeFileSync(logPath, JSON.stringify(line) + "\n");

  const victim = new EventStore(dir);
  assert.throws(() => victim.load(), /哈希链/);
});

test("审计事件可按器物、经办人、类型、时间过滤，每条含依据与经办信息", async () => {
  const svc = newService();
  const id = await setupArtifact(svc, "JD-77");
  await svc.correctInfo(id, {
    actor: ADMIN,
    reason: "名称勘误",
    basis: BASIS,
    info: { name: "青瓷盏（更正名）" },
  });
  const audit = svc.audit({ type: "artifact_info_corrected", actorId: "u1" });
  assert.equal(audit.count, 1);
  assert.equal(audit.events[0].data.basis.documentId, "DB-2026-11");
  assert.equal(audit.events[0].actor.name, "王管理员");
  assert.equal(audit.headHash, svc.headHash());
  assert.equal(svc.audit({ artifactId: id }).events.length >= 3, true);
});
