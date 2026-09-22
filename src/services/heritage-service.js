import { EventStore } from "../store/event-store.js";
import { apply, replay } from "../domain/projection.js";
import { createLock } from "../util/lock.js";
import {
  newEventId,
  newTransferId,
  newLoanId,
  newExhibitionId,
  artifactIdOfSeq,
  batchIdOfSeq,
  normalizeNumber,
  looseNumberKey,
  fingerprintOf,
} from "../domain/identifiers.js";
import {
  notFound,
  conflict,
  failedPrecondition,
  forbidden,
  validationFailed,
} from "../domain/errors.js";
import { validate, validators as v } from "../domain/validators.js";

const MUTABLE_STATUSES = new Set(["draft", "registered"]);
const WRITER_ROLES = new Set(["管理员", "保护人员"]);
const ADMIN_ONLY = new Set([
  "artifact_registered",
  "draft_voided",
  "artifact_merged",
  "artifact_split",
  "artifact_number_unlinked",
  "transfer_created",
  "transfer_dispatched",
  "transfer_accepted",
  "transfer_rejected",
  "transfer_cancelled",
  "loan_opened",
  "loan_returned",
  "exhibition_opened",
  "exhibition_closed",
  "artifact_appraisal_updated",
]);

const ARTIFACT_FIELDS = [
  "name",
  "category",
  "dynasty",
  "material",
  "dimensions",
  "description",
];
const EXCAVATION_FIELDS = ["site", "location", "date", "method"];
const AUTHENTICATION_FIELDS = ["opinion", "confidence", "organization", "authenticator"];

export class HeritageService {
  constructor({ dataDir, ownOrg = "市博物馆", clock = () => new Date() } = {}) {
    if (!dataDir) throw new Error("HeritageService 需要 dataDir");
    this.store = new EventStore(dataDir);
    this.state = null;
    this.lock = createLock();
    this.clock = clock;
    // 本馆机构名称：保管关系与移交方校验都以它为准。
    this.ownOrg = ownOrg;
  }

  start() {
    const info = this.store.load();
    this.state = replay(this.store.all());
    return { ...info, headHash: this.store.headHash() };
  }

  now() {
    return this.clock().toISOString();
  }

  headHash() {
    return this.store.headHash();
  }

  // ---- 内部工具 -------------------------------------------------------

  requireActor(rawBody, action) {
    const actor = rawBody?.actor;
    validate({ actor }, (c, body) => {
      if (!c.object(body.actor, "actor", "经办人")) return;
      c.require(body.actor.id, "actor.id", "经办人标识");
      c.string(body.actor.id, "actor.id", "经办人标识", { max: 100 });
      c.require(body.actor.name, "actor.name", "经办人姓名");
      c.string(body.actor.name, "actor.name", "经办人姓名", { max: 100 });
      // 角色必填：缺省不得按管理员放行，避免越权。
      c.require(body.actor.role, "actor.role", "经办角色");
      c.enum(body.actor.role, "actor.role", "经办角色", ["管理员", "保护人员", "只读访客"]);
    });
    if (!WRITER_ROLES.has(actor.role)) {
      throw forbidden(`只读访客不能执行：${action}`, { actorId: actor.id });
    }
    if (actor.role === "保护人员" && ADMIN_ONLY.has(action)) {
      throw forbidden(`该操作需要管理员角色：${action}`, { actorId: actor.id });
    }
    return { id: actor.id, name: actor.name, role: actor.role };
  }

  requireBasis(body, { label = "操作依据" } = {}) {
    const basis = body.basis;
    if (!basis || typeof basis !== "object") {
      throw validationFailed([{ field: "basis", issue: `必须提供${label}` }]);
    }
    if (!basis.document && !basis.documentId && !basis.note) {
      throw validationFailed([
        { field: "basis", issue: "依据至少包含文件、文件编号或说明之一" },
      ]);
    }
    return {
      document: basis.document ?? null,
      documentId: basis.documentId ?? null,
      note: basis.note ?? null,
    };
  }

  record(type, data, actor, { batchId = null, id = null } = {}) {
    const event = this.store.append({
      id: id ?? newEventId(),
      type,
      at: this.now(),
      actor: { id: actor.id, name: actor.name, role: actor.role },
      batchId,
      data,
    });
    // 写路径做增量折叠；启动时才全量重放。
    apply(this.state, event);
    return event;
  }

  // 编号占用检查：草稿 pending 与正式 alias 均构成唯一占用。
  numberConflicts(numbers, { ignoreArtifactId = null } = {}) {
    const reasons = [];
    for (const entry of numbers) {
      const key = normalizeNumber(entry.number);
      const active = this.state.activeByNumber.get(key);
      if (active && active.artifactId !== ignoreArtifactId) {
        reasons.push({
          type: "number_already_registered",
          number: entry.number,
          namespace: entry.namespace,
          heldBy: active.artifactId,
          heldNamespace: active.namespace,
          message: `编号 ${entry.number} 已正式登记在器物 ${active.artifactId} 名下`,
        });
      }
      const pending = this.state.pendingByNumber.get(key);
      if (pending && pending.artifactId !== ignoreArtifactId) {
        reasons.push({
          type: "number_held_by_draft",
          number: entry.number,
          namespace: entry.namespace,
          heldBy: pending.artifactId,
          heldBatch: pending.batchId,
          message: `编号 ${entry.number} 已被草稿 ${pending.artifactId}（批次 ${pending.batchId}）占用待核验`,
        });
      }
    }
    return reasons;
  }

  // 宽松软冲突：扫描其他器物的在用/待核验编号，仅分隔符或空白不同
  //（如 JD-001 与 jd001）。不构成唯一约束，但必须显式 allowDuplicates 放行。
  numberSoftConflicts(numbers, { ignoreArtifactId = null } = {}) {
    const reasons = [];
    for (const entry of numbers) {
      const key = looseNumberKey(entry.number);
      for (const artifact of this.state.artifacts.values()) {
        if (artifact.id === ignoreArtifactId) continue;
        const candidates = [
          ...artifact.aliases.filter((a) => a.status === "active"),
          ...artifact.pendingNumbers,
        ];
        for (const candidate of candidates) {
          if (looseNumberKey(candidate.number) === key && normalizeNumber(candidate.number) !== normalizeNumber(entry.number)) {
            reasons.push({
              type: "number_similar_format",
              number: entry.number,
              matchedNumber: candidate.number,
              heldBy: artifact.id,
              heldNamespace: candidate.namespace,
              message:
                `编号 ${entry.number} 与器物 ${artifact.id} 已有的 ${candidate.number} ` +
                "仅分隔符/大小写不同，疑似同一编号，请核对来源后确认",
            });
          }
        }
      }
    }
    return reasons;
  }

  fingerprintConflicts(info, excavation, { ignoreArtifactId = null } = {}) {
    const fp = fingerprintOf(info ?? {}, excavation ?? {});
    const ids = [...(this.state.fingerprints.get(fp) ?? [])].filter(
      (id) => id !== ignoreArtifactId,
    );
    return ids.map((id) => ({
      type: "possible_duplicate_artifact",
      artifactId: id,
      message: `器物 ${id} 的名称/品类/出土地点完全相同，可能是同一器物的重复登记`,
    }));
  }

  getArtifact(idOrNumber) {
    let artifact = this.state.artifacts.get(idOrNumber);
    if (artifact) return artifact;
    const key = normalizeNumber(idOrNumber);
    const holder = this.state.activeByNumber.get(key);
    if (holder) {
      artifact = this.state.artifacts.get(holder.artifactId);
      if (artifact) return artifact;
    }
    throw notFound("器物", idOrNumber);
  }

  requireMutable(artifact) {
    if (!MUTABLE_STATUSES.has(artifact.status)) {
      throw failedPrecondition(`器物 ${artifact.id} 当前状态为 ${artifact.status}，不可变更`, {
        artifactId: artifact.id,
        status: artifact.status,
      });
    }
  }

  requireInHouse(artifact) {
    if (artifact.custody.holder !== "本馆") {
      throw failedPrecondition(
        `器物 ${artifact.id} 现由 ${this.holderName(artifact.custody.holder)} 保管`,
        {
          artifactId: artifact.id,
          holder: this.holderName(artifact.custody.holder),
        },
      );
    }
  }

  // 内部持有方标记 "本馆" 与配置的实际机构名称互转。
  holderName(holder) {
    return holder === "本馆" ? this.ownOrg : holder;
  }

  holderToken(org) {
    return org === this.ownOrg ? "本馆" : org;
  }

  blockIfInUse(artifactIds) {
    const reasons = [];
    for (const id of artifactIds) {
      const artifact = this.state.artifacts.get(id);
      if (!artifact) {
        reasons.push({ type: "missing_artifact", artifactId: id, message: `器物 ${id} 不存在` });
        continue;
      }
      for (const loanId of artifact.activeLoanIds) {
        const loan = this.state.loans.get(loanId);
        reasons.push({
          type: "artifact_on_loan",
          artifactId: id,
          loanId,
          borrower: loan?.borrower,
          message: `器物 ${id} 正在出借中（出借单 ${loanId}，借入方 ${loan?.borrower ?? "未知"}），不能执行该操作`,
        });
      }
      for (const exhibitionId of artifact.activeExhibitionIds) {
        const exhibition = this.state.exhibitions.get(exhibitionId);
        reasons.push({
          type: "artifact_on_exhibition",
          artifactId: id,
          exhibitionId,
          exhibitionName: exhibition?.name,
          message: `器物 ${id} 正在展览中（展览 ${exhibitionId}：${exhibition?.name ?? "未命名"}），不能执行该操作`,
        });
      }
      if (artifact.custody.transferId) {
        reasons.push({
          type: "artifact_in_transit",
          artifactId: id,
          transferId: artifact.custody.transferId,
          message: `器物 ${id} 处于跨馆移交 ${artifact.custody.transferId} 途中`,
        });
      }
    }
    return reasons;
  }

  // ---- 批次 -----------------------------------------------------------

  openBatch(rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "batch_opened");
      validate(body, (c) => {
        c.string(body.note, "note", "批次说明", { max: 500 });
      });
      const seq = this.state.seq.batch + 1;
      const batchId = body.batchId ?? batchIdOfSeq(seq);
      if (this.state.batches.has(batchId)) {
        throw conflict(`批次编号已存在：${batchId}`, [
          { type: "batch_exists", batchId, message: "批次编号冲突，请更换或省略以自动生成" },
        ]);
      }
      const event = this.record(
        "batch_opened",
        { batchId, batchSeq: seq, note: body.note ?? null },
        actor,
        { batchId },
      );
      return { batch: this.batchView(this.state.batches.get(batchId)), event };
    });
  }

  sealBatch(batchId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "batch_sealed");
      const batch = this.state.batches.get(batchId);
      if (!batch) throw notFound("批次", batchId);
      if (batch.status !== "open") {
        throw failedPrecondition(`批次 ${batchId} 已${batch.status === "sealed" ? "封存" : "关闭"}`, {
          batchId,
          status: batch.status,
        });
      }
      const drafts = batch.artifactIds.filter(
        (id) => this.state.artifacts.get(id)?.status === "draft",
      );
      if (drafts.length) {
        throw failedPrecondition(`批次 ${batchId} 内仍有 ${drafts.length} 件草稿未登记或撤销`, {
          batchId,
          draftArtifactIds: drafts,
        });
      }
      const event = this.record("batch_sealed", {}, actor, { batchId });
      return { batch: this.batchView(batch), event };
    });
  }

  // ---- 器物登记 -------------------------------------------------------

  createArtifact(rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_created");
      this.#validateCreate(body);
      const batchId = body.batchId;
      const batch = this.state.batches.get(batchId);
      if (!batch) throw notFound("批次", batchId);
      if (batch.status !== "open") {
        throw failedPrecondition(`批次 ${batchId} 已封存，不能再录入器物`, {
          batchId,
          status: batch.status,
        });
      }

      const numbers = body.numbers ?? [];
      let reasons = [
        ...this.numberConflicts(numbers),
        ...this.numberSoftConflicts(numbers),
        ...this.fingerprintConflicts(body.info, body.excavation ?? {}),
      ];
      if (reasons.length && body.allowDuplicates !== true) {
        throw conflict("该器物可能与既有登记冲突，已阻止创建；核对后可带 allowDuplicates=true 显式放行", reasons);
      }
      if (body.allowDuplicates === true) reasons = [];

      const seq = this.state.seq.artifact + 1;
      const artifactId = body.artifactId ?? artifactIdOfSeq(seq);
      if (this.state.artifacts.has(artifactId)) {
        throw conflict(`器物身份标识已存在：${artifactId}`, [
          { type: "artifact_exists", artifactId, message: "不可变身份标识冲突" },
        ]);
      }

      const event = this.record(
        "artifact_created",
        {
          artifactId,
          artifactSeq: seq,
          info: body.info,
          excavation: body.excavation ?? null,
          pendingNumbers: numbers.map((n) => ({
            number: n.number,
            namespace: n.namespace,
            source: n.source ?? null,
          })),
          fingerprint: fingerprintOf(body.info, body.excavation ?? {}),
          // 放行时把经办人事先看到的冲突原样写入事件，供事后复核。
          acknowledgedConflicts:
            body.allowDuplicates === true && reasons.length ? reasons : [],
        },
        actor,
        { batchId },
      );
      return {
        artifact: this.artifactView(this.state.artifacts.get(artifactId)),
        event,
        warnings: reasons,
      };
    });
  }

  #validateCreate(body) {
    validate(body, (c) => {
      c.require(body.batchId, "batchId", "接收批次");
      c.string(body.batchId, "batchId", "接收批次", { max: 100 });
      c.require(body.info, "info", "器物基本信息");
      v.info(c, body.info, "info");
      if (body.excavation !== undefined) v.excavation(c, body.excavation, "excavation");
      c.array(body.numbers, "numbers", "待核验编号列表");
      if (Array.isArray(body.numbers)) {
        if (body.numbers.length === 0) c.errors.push({ field: "numbers", issue: "至少提供一个旧档/清单/扫描编号" });
        body.numbers.forEach((n, i) => v.number(c, n, `numbers[${i}]`));
        const values = body.numbers.map((n) => n?.number).filter(Boolean);
        if (new Set(values.map(normalizeNumber)).size !== values.length) {
          c.errors.push({ field: "numbers", issue: "同一请求中的编号不能重复" });
        }
      }
      if (body.allowDuplicates !== undefined) typeof body.allowDuplicates !== "boolean" && c.errors.push({ field: "allowDuplicates", issue: "必须为布尔值" });
    });
  }

  registerArtifact(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_registered");
      const artifact = this.getArtifact(artifactId);
      if (artifact.status !== "draft") {
        throw failedPrecondition(`器物 ${artifact.id} 不是草稿（当前 ${artifact.status}），不能登记`, {
          artifactId: artifact.id,
          status: artifact.status,
        });
      }
      if (artifact.pendingNumbers.length === 0) {
        throw failedPrecondition(`器物 ${artifact.id} 没有任何待核验编号，无法完成登记`, {
          artifactId: artifact.id,
        });
      }
      // 登记前最后核验：编号占用可能在草稿存活期被其他渠道感知（正常被 pending 锁住，此处为兜底）。
      const reasons = this.numberConflicts(
        artifact.pendingNumbers.map((p) => ({ number: p.number, namespace: p.namespace })),
        { ignoreArtifactId: artifact.id },
      );
      if (reasons.length) throw conflict("登记前核验发现编号冲突", reasons);

      const event = this.record("artifact_registered", { artifactId: artifact.id }, actor, {
        batchId: artifact.batchId,
      });
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  voidDraft(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "draft_voided");
      const artifact = this.getArtifact(artifactId);
      if (artifact.status !== "draft") {
        throw failedPrecondition(`只有草稿可以撤销；器物 ${artifact.id} 当前为 ${artifact.status}`, {
          artifactId: artifact.id,
          status: artifact.status,
        });
      }
      // 撤销只影响尚未用于出借或展览的草稿（在借在展显式列入原因）。
      const reasons = this.blockIfInUse([artifact.id]);
      if (reasons.length) throw conflict("草稿已被业务单据占用，不能撤销", reasons);
      if (!body.reason || typeof body.reason !== "string") {
        throw validationFailed([{ field: "reason", issue: "撤销必须填写原因" }]);
      }
      const basis = this.requireBasis(body);
      const event = this.record(
        "draft_voided",
        { artifactId: artifact.id, reason: body.reason, basis },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  // ---- 编号更正 -------------------------------------------------------

  linkNumber(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_number_linked");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      this.requireInHouse(artifact);
      validate(body, (c) => v.number(c, body.number, "number"));
      const basis = this.requireBasis(body, { label: "编号来源依据" });
      const reasons = [
        ...this.numberConflicts([body.number], { ignoreArtifactId: artifact.id }),
        ...this.numberSoftConflicts([body.number], { ignoreArtifactId: artifact.id }),
      ];
      if (reasons.length) throw conflict("编号关联被拒绝", reasons);
      // 草稿期录入的编号只能是"待核验"，登记时才转为正式别名。
      const type = artifact.status === "draft" ? "number_added_pending" : "artifact_number_linked";
      const event = this.record(
        type,
        { artifactId: artifact.id, number: body.number, basis },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  unlinkNumber(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_number_unlinked");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      validate(body, (c) => {
        c.require(body.number, "number", "要解除的编号");
        c.string(body.number, "number", "要解除的编号", { max: 100 });
        c.require(body.reason, "reason", "解除原因");
        c.string(body.reason, "reason", "解除原因", { max: 1000 });
      });
      const basis = this.requireBasis(body);
      const key = normalizeNumber(body.number);
      const alias = artifact.aliases.find((a) => a.normalized === key && a.status === "active");

      // 草稿的待核验编号可直接移除（占用随即释放）；正式编号解除需在器物无在途业务时进行。
      if (!alias && artifact.status === "draft") {
        const pending = artifact.pendingNumbers.find((p) => p.normalized === key);
        if (!pending) throw notFound(`器物 ${artifact.id} 的待核验编号`, body.number);
        const event = this.record(
          "draft_number_removed",
          { artifactId: artifact.id, number: pending.number, reason: body.reason, basis },
          actor,
          { batchId: artifact.batchId },
        );
        return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
      }
      if (!alias) throw notFound(`器物 ${artifact.id} 的在用编号`, body.number);

      const reasons = this.blockIfInUse([artifact.id]);
      if (reasons.length) throw conflict("器物在借在展或移交途中，不能解除编号", reasons);
      const event = this.record(
        "artifact_number_unlinked",
        { artifactId: artifact.id, number: alias.number, reason: body.reason, basis },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  // ---- 信息/估值/库位/照片 --------------------------------------------

  correctInfo(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_info_corrected");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      validate(body, (c) => {
        // 更正是局部补丁，未提供的字段不做必填校验。
        if (body.info !== undefined) v.info(c, body.info, "info", { partial: true });
        if (body.excavation !== undefined) v.excavation(c, body.excavation, "excavation");
      });
      const infoPatch = pick(body.info, ARTIFACT_FIELDS);
      const excavationPatch = pick(body.excavation, EXCAVATION_FIELDS);
      if (Object.keys(infoPatch).length === 0 && Object.keys(excavationPatch).length === 0) {
        throw validationFailed([
          { field: "info", issue: "至少提供一个要更正的字段（info 或 excavation）" },
        ]);
      }
      if (!body.reason) throw validationFailed([{ field: "reason", issue: "更正必须填写原因" }]);
      const basis = this.requireBasis(body);

      const mergedInfo = { ...artifact.info, ...infoPatch };
      const mergedExcavation = { ...(artifact.excavation ?? {}), ...excavationPatch };
      const fpReasons = this.fingerprintConflicts(mergedInfo, mergedExcavation, {
        ignoreArtifactId: artifact.id,
      });
      if (fpReasons.length && body.allowDuplicates !== true) {
        throw conflict("更正后与其他器物高度相似，可能指向同一器物；核对后可显式放行", fpReasons);
      }

      const event = this.record(
        "artifact_info_corrected",
        {
          artifactId: artifact.id,
          fields: { info: infoPatch, excavation: excavationPatch },
          reason: body.reason,
          basis,
        },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  updateAppraisal(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_appraisal_updated");
      const artifact = this.getArtifact(artifactId);
      if (artifact.status !== "registered") {
        throw failedPrecondition(`只有已登记器物才能记录保险估值（当前 ${artifact.status}）`, {
          artifactId: artifact.id,
          status: artifact.status,
        });
      }
      validate(body, (c) => {
        c.require(body.appraisal, "appraisal", "估值信息");
        if (!c.object(body.appraisal, "appraisal", "估值信息")) return;
        const a = body.appraisal;
        c.require(a.value, "appraisal.value", "估值金额");
        if (a.value !== undefined && (typeof a.value !== "number" || a.value <= 0)) {
          c.errors.push({ field: "appraisal.value", issue: "估值金额必须是正数" });
        }
        c.require(a.currency, "appraisal.currency", "币种");
        c.string(a.currency, "appraisal.currency", "币种", { max: 10 });
        c.require(a.insurer, "appraisal.insurer", "保险机构");
        c.string(a.insurer, "appraisal.insurer", "保险机构", { max: 200 });
        c.string(a.policyNo, "appraisal.policyNo", "保单号", { max: 200 });
        c.string(a.note, "appraisal.note", "估值说明", { max: 1000 });
      });
      const basis = this.requireBasis(body, { label: "估值依据（评估报告/保单）" });
      const appraisal = {
        value: body.appraisal.value,
        currency: body.appraisal.currency,
        insurer: body.appraisal.insurer,
        policyNo: body.appraisal.policyNo ?? null,
        note: body.appraisal.note ?? null,
        basis,
      };
      const event = this.record(
        "artifact_appraisal_updated",
        { artifactId: artifact.id, appraisal },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  updateStorage(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_storage_updated");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      validate(body, (c) => {
        c.require(body.storage, "storage", "库位信息");
        if (!c.object(body.storage, "storage", "库位信息")) return;
        c.require(body.storage.location, "storage.location", "库房/位置");
        c.string(body.storage.location, "storage.location", "库房/位置", { max: 300 });
        c.string(body.storage.shelfCode, "storage.shelfCode", "货架/柜格编码", { max: 100 });
        c.string(body.storage.note, "storage.note", "库位备注", { max: 1000 });
      });
      const storage = {
        location: body.storage.location,
        shelfCode: body.storage.shelfCode ?? null,
        note: body.storage.note ?? null,
      };
      const event = this.record(
        "artifact_storage_updated",
        { artifactId: artifact.id, storage },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  updatePhotos(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_photos_updated");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      validate(body, (c) => v.photos(c, body.photos, "photos"));
      if (!Array.isArray(body.photos) || body.photos.length === 0) {
        throw validationFailed([{ field: "photos", issue: "照片索引不能为空（至少一张）" }]);
      }
      const photos = body.photos.map((p) => ({
        photoId: p.photoId,
        uri: p.uri ?? null,
        caption: p.caption ?? null,
      }));
      const event = this.record(
        "artifact_photos_updated",
        { artifactId: artifact.id, photos },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  // ---- 鉴定意见版本 ---------------------------------------------------

  addAuthentication(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "authentication_added");
      const artifact = this.getArtifact(artifactId);
      this.requireMutable(artifact);
      this.#validateAuthentication(body);
      const basis = body.authentication.basis
        ? {
            document: body.authentication.basis.document ?? null,
            documentId: body.authentication.basis.documentId ?? null,
            note: body.authentication.basis.note ?? null,
          }
        : null;
      let supersedes = null;
      if (body.supersedes) {
        const found = artifact.authentications.some((a) => a.id === body.supersedes);
        if (!found) throw notFound("被修订的鉴定意见", body.supersedes);
        supersedes = body.supersedes;
      } else if (artifact.currentAuthenticationId) {
        supersedes = artifact.currentAuthenticationId;
      }
      const authenticationId = body.authenticationId ?? `auth_${artifact.seq}_${artifact.authentications.length + 1}`;
      if (artifact.authentications.some((a) => a.id === authenticationId)) {
        throw conflict(`鉴定意见编号重复：${authenticationId}`, [
          { type: "authentication_exists", authenticationId },
        ]);
      }
      const event = this.record(
        "authentication_added",
        {
          artifactId: artifact.id,
          authenticationId,
          authentication: {
            authenticator: body.authentication.authenticator,
            organization: body.authentication.organization ?? null,
            opinion: body.authentication.opinion,
            confidence: body.authentication.confidence ?? null,
            attaches: body.authentication.attaches ?? [],
            basis,
          },
          supersedes,
        },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  #validateAuthentication(body) {
    validate(body, (c) => {
      c.require(body.authentication, "authentication", "鉴定意见");
      if (!c.object(body.authentication, "authentication", "鉴定意见")) return;
      const a = body.authentication;
      c.require(a.authenticator, "authentication.authenticator", "鉴定人");
      c.string(a.authenticator, "authentication.authenticator", "鉴定人", { max: 200 });
      c.string(a.organization, "authentication.organization", "鉴定机构", { max: 200 });
      c.require(a.opinion, "authentication.opinion", "鉴定结论");
      c.string(a.opinion, "authentication.opinion", "鉴定结论", { max: 5000 });
      c.enum(a.confidence, "authentication.confidence", "可信程度", ["高", "中", "低", "存疑"]);
      c.array(a.attaches, "authentication.attaches", "附件索引");
      if (Array.isArray(a.attaches)) {
        a.attaches.forEach((item, i) => c.string(item, `authentication.attaches[${i}]`, "附件", { max: 500 }));
      }
      c.string(body.supersedes, "supersedes", "被修订意见编号", { max: 100 });
    });
  }

  correctAuthentication(artifactId, authenticationId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "authentication_corrected");
      const artifact = this.getArtifact(artifactId);
      const record = artifact.authentications.find((a) => a.id === authenticationId);
      if (!record) throw notFound("鉴定意见", authenticationId);
      validate(body, (c) => {
        c.require(body.fields, "fields", "更正字段");
        if (!c.object(body.fields, "fields", "更正字段")) return;
        for (const key of Object.keys(body.fields)) {
          if (!AUTHENTICATION_FIELDS.includes(key)) {
            c.errors.push({ field: `fields.${key}`, issue: "不允许更正的字段" });
          }
        }
        if (typeof body.fields.confidence !== "undefined") {
          c.enum(body.fields.confidence, "fields.confidence", "可信程度", ["高", "中", "低", "存疑"]);
        }
      });
      const fields = pick(body.fields, AUTHENTICATION_FIELDS);
      if (Object.keys(fields).length === 0) {
        throw validationFailed([{ field: "fields", issue: "没有可更正的字段" }]);
      }
      if (!body.reason) throw validationFailed([{ field: "reason", issue: "更正必须填写原因" }]);
      const basis = this.requireBasis(body);
      const event = this.record(
        "authentication_corrected",
        { artifactId: artifact.id, authenticationId, fields, reason: body.reason, basis },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  retractAuthentication(artifactId, authenticationId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "authentication_retracted");
      const artifact = this.getArtifact(artifactId);
      const record = artifact.authentications.find((a) => a.id === authenticationId);
      if (!record) throw notFound("鉴定意见", authenticationId);
      if (record.status === "retracted") {
        throw failedPrecondition("鉴定意见已撤回", { authenticationId });
      }
      if (!body.reason) throw validationFailed([{ field: "reason", issue: "撤回必须填写原因" }]);
      const basis = this.requireBasis(body);
      const event = this.record(
        "authentication_retracted",
        { artifactId: artifact.id, authenticationId, reason: body.reason, basis },
        actor,
        { batchId: artifact.batchId },
      );
      return { artifact: this.artifactView(this.state.artifacts.get(artifact.id)), event };
    });
  }

  // ---- 合并 / 拆分 ----------------------------------------------------

  mergeArtifacts(rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_merged");
      validate(body, (c) => {
        c.array(body.artifactIds, "artifactIds", "待合并器物");
        if (Array.isArray(body.artifactIds)) {
          if (body.artifactIds.length < 2) c.errors.push({ field: "artifactIds", issue: "合并至少需要两件器物" });
          body.artifactIds.forEach((id, i) => c.string(id, `artifactIds[${i}]`, "器物标识", { max: 100 }));
        }
        c.require(body.survivorId, "survivorId", "合并后保留的身份");
        c.string(body.survivorId, "survivorId", "合并后保留的身份", { max: 100 });
        c.require(body.reason, "reason", "合并原因");
        c.string(body.reason, "reason", "合并原因", { max: 1000 });
      });
      const basis = this.requireBasis(body);
      const ids = [...new Set(body.artifactIds)];
      if (ids.length !== body.artifactIds.length) {
        throw validationFailed([{ field: "artifactIds", issue: "器物标识不能重复" }]);
      }
      if (!ids.includes(body.survivorId)) {
        throw validationFailed([
          { field: "survivorId", issue: "保留身份必须在待合并器物列表中" },
        ]);
      }
      const reasons = [];
      for (const id of ids) {
        const artifact = this.state.artifacts.get(id);
        if (!artifact) {
          reasons.push({ type: "missing_artifact", artifactId: id, message: `器物 ${id} 不存在` });
          continue;
        }
        if (!MUTABLE_STATUSES.has(artifact.status)) {
          reasons.push({
            type: "artifact_not_mutable",
            artifactId: id,
            status: artifact.status,
            message: `器物 ${id} 状态为 ${artifact.status}，不能合并`,
          });
        }
      }
      // 阶段混用会让草稿的待核验编号滞留：已登记的幸存身份无法再走登记转换。
      const survivor = this.state.artifacts.get(body.survivorId);
      if (survivor?.status === "registered") {
        const draftSources = ids
          .filter((id) => id !== body.survivorId)
          .filter((id) => this.state.artifacts.get(id)?.status === "draft");
        for (const id of draftSources) {
          reasons.push({
            type: "draft_merged_into_registered",
            artifactId: id,
            survivorId: body.survivorId,
            message:
              `器物 ${id} 仍是草稿而幸存身份 ${body.survivorId} 已登记；` +
              "请先将该草稿登记或撤销后再合并",
          });
        }
      }
      reasons.push(...this.blockIfInUse(ids));
      if (reasons.length) throw conflict("合并不被允许", reasons);

      const sourceIds = ids.filter((id) => id !== body.survivorId);
      const event = this.record(
        "artifact_merged",
        { survivorId: body.survivorId, sourceIds, reason: body.reason, basis },
        actor,
      );
      return { artifact: this.artifactView(this.state.artifacts.get(body.survivorId)), merged: sourceIds, event };
    });
  }

  splitArtifact(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "artifact_split");
      const parent = this.getArtifact(artifactId);
      validate(body, (c) => {
        c.require(body.reason, "reason", "拆分原因");
        c.string(body.reason, "reason", "拆分原因", { max: 1000 });
        c.require(body.children, "children", "拆分子件列表");
        c.array(body.children, "children", "拆分子件列表");
        if (Array.isArray(body.children)) {
          if (body.children.length < 2) c.errors.push({ field: "children", issue: "拆分至少产生两件器物" });
          body.children.forEach((child, i) => {
            c.require(child?.info, `children[${i}].info`, "子件基本信息");
            v.info(c, child?.info ?? {}, `children[${i}].info`);
            if (!Array.isArray(child?.numbers) || child.numbers.length === 0) {
              c.errors.push({ field: `children[${i}].numbers`, issue: "每个子件至少提供一个待核验编号" });
            }
            (child?.numbers ?? []).forEach((n, j) =>
              v.number(c, n, `children[${i}].numbers[${j}]`),
            );
          });
        }
      });
      const basis = this.requireBasis(body);
      const reasons = [];
      if (!MUTABLE_STATUSES.has(parent.status)) {
        reasons.push({
          type: "artifact_not_mutable",
          artifactId: parent.id,
          status: parent.status,
          message: `器物 ${parent.id} 状态为 ${parent.status}，不能拆分`,
        });
      }
      reasons.push(...this.blockIfInUse([parent.id]));
      const allNumbers = body.children.flatMap((c) => c.numbers ?? []);
      reasons.push(...this.numberConflicts(allNumbers));
      reasons.push(...this.numberSoftConflicts(allNumbers));
      const localValues = allNumbers.map((n) => normalizeNumber(n.number));
      if (new Set(localValues).size !== localValues.length) {
        reasons.push({ type: "duplicate_numbers_in_request", message: "子件之间编号不能重复" });
      }
      if (reasons.length) throw conflict("拆分不被允许", reasons);

      // 拆分自动开立一个新批次承接子件草稿，原批次保持封存状态不受影响。
      const batchSeq = this.state.seq.batch + 1;
      const childBatchId = batchIdOfSeq(batchSeq);
      this.record(
        "batch_opened",
        { batchId: childBatchId, batchSeq, note: `拆分自器物 ${parent.id}` },
        actor,
        { batchId: childBatchId },
      );

      // 注意：序号在事件应用前不会自增，这里用本地计数器为每个子件分配唯一年序号。
      let nextSeq = this.state.seq.artifact + 1;
      const children = body.children.map((child) => {
        const seq = nextSeq++;
        const id = artifactIdOfSeq(seq);
        return {
          artifactId: id,
          artifactSeq: seq,
          batchId: childBatchId,
          info: pick(child.info, ARTIFACT_FIELDS),
          pendingNumbers: (child.numbers ?? []).map((n) => ({
            number: n.number,
            namespace: n.namespace,
            source: n.source ?? null,
          })),
        };
      });
      const event = this.record(
        "artifact_split",
        { parentId: parent.id, children, reason: body.reason, basis },
        actor,
        { batchId: childBatchId },
      );
      return {
        parent: this.artifactView(this.state.artifacts.get(parent.id)),
        children: children.map((c) => this.artifactView(this.state.artifacts.get(c.artifactId))),
        batchId: childBatchId,
        event,
      };
    });
  }

  // ---- 出借 / 展览（撤销保护的占用来源） -------------------------------

  openLoan(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "loan_opened");
      const artifact = this.getArtifact(artifactId);
      if (artifact.status !== "registered") {
        throw failedPrecondition(`只有已登记器物可以出借（当前 ${artifact.status}）`, {
          artifactId: artifact.id,
          status: artifact.status,
        });
      }
      this.requireInHouse(artifact);
      validate(body, (c) => {
        c.require(body.borrower, "borrower", "借入方");
        c.string(body.borrower, "borrower", "借入方", { max: 200 });
        c.require(body.loanNo, "loanNo", "出借单号");
        c.string(body.loanNo, "loanNo", "出借单号", { max: 100 });
        c.string(body.dueAt, "dueAt", "应还日期", { max: 100 });
      });
      const inUse = this.blockIfInUse([artifact.id]);
      if (inUse.length) throw conflict("器物已有在途业务，不能出借", inUse);
      const loanId = newLoanId();
      const loan = {
        artifactId: artifact.id,
        borrower: body.borrower,
        loanNo: body.loanNo,
        dueAt: body.dueAt ?? null,
      };
      const event = this.record("loan_opened", { loanId, loan }, actor, {
        batchId: artifact.batchId,
      });
      return { loan: this.state.loans.get(loanId), event };
    });
  }

  returnLoan(loanId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "loan_returned");
      const loan = this.state.loans.get(loanId);
      if (!loan) throw notFound("出借单", loanId);
      if (loan.status !== "active") {
        throw failedPrecondition(`出借单 ${loanId} 状态为 ${loan.status}`, { loanId, status: loan.status });
      }
      const event = this.record("loan_returned", { loanId }, actor);
      return { loan: this.state.loans.get(loanId), event };
    });
  }

  openExhibition(artifactId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "exhibition_opened");
      const artifact = this.getArtifact(artifactId);
      if (artifact.status !== "registered") {
        throw failedPrecondition(`只有已登记器物可以参展（当前 ${artifact.status}）`, {
          artifactId: artifact.id,
          status: artifact.status,
        });
      }
      this.requireInHouse(artifact);
      validate(body, (c) => {
        c.require(body.name, "name", "展览名称");
        c.string(body.name, "name", "展览名称", { max: 300 });
        c.require(body.venue, "venue", "展出场馆");
        c.string(body.venue, "venue", "展出场馆", { max: 300 });
        c.string(body.exhibitionNo, "exhibitionNo", "展览编号", { max: 100 });
      });
      const inUse = this.blockIfInUse([artifact.id]);
      if (inUse.length) throw conflict("器物已有在途业务，不能参展", inUse);
      const exhibitionId = newExhibitionId();
      const exhibition = {
        artifactId: artifact.id,
        name: body.name,
        venue: body.venue,
        exhibitionNo: body.exhibitionNo ?? null,
      };
      const event = this.record("exhibition_opened", { exhibitionId, exhibition }, actor, {
        batchId: artifact.batchId,
      });
      return { exhibition: this.state.exhibitions.get(exhibitionId), event };
    });
  }

  closeExhibition(exhibitionId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "exhibition_closed");
      const exhibition = this.state.exhibitions.get(exhibitionId);
      if (!exhibition) throw notFound("展览", exhibitionId);
      if (exhibition.status !== "active") {
        throw failedPrecondition(`展览 ${exhibitionId} 状态为 ${exhibition.status}`, {
          exhibitionId,
          status: exhibition.status,
        });
      }
      const event = this.record("exhibition_closed", { exhibitionId }, actor);
      return { exhibition: this.state.exhibitions.get(exhibitionId), event };
    });
  }

  // ---- 跨馆移交 -------------------------------------------------------

  createTransfer(rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "transfer_created");
      validate(body, (c) => {
        c.require(body.artifactIds, "artifactIds", "移交器物");
        c.array(body.artifactIds, "artifactIds", "移交器物");
        if (Array.isArray(body.artifactIds)) {
          if (body.artifactIds.length === 0) c.errors.push({ field: "artifactIds", issue: "移交器物不能为空" });
          body.artifactIds.forEach((id, i) => c.string(id, `artifactIds[${i}]`, "器物标识", { max: 100 }));
        }
        c.require(body.fromOrg, "fromOrg", "移交方");
        c.string(body.fromOrg, "fromOrg", "移交方", { max: 200 });
        c.require(body.toOrg, "toOrg", "接收方");
        c.string(body.toOrg, "toOrg", "接收方", { max: 200 });
        c.string(body.reason, "reason", "移交事由", { max: 1000 });
        c.string(body.note, "note", "备注", { max: 1000 });
      });
      if (body.fromOrg === body.toOrg) {
        throw validationFailed([{ field: "toOrg", issue: "接收方与移交方不能相同" }]);
      }
      const ids = [...new Set(body.artifactIds ?? [])];
      const reasons = [];
      for (const id of ids) {
        const artifact = this.state.artifacts.get(id);
        if (!artifact) {
          reasons.push({ type: "missing_artifact", artifactId: id, message: `器物 ${id} 不存在` });
          continue;
        }
        if (artifact.status !== "registered") {
          reasons.push({
            type: "artifact_not_registered",
            artifactId: id,
            status: artifact.status,
            message: `器物 ${id} 尚未正式登记（${artifact.status}），不能移交`,
          });
        }
        if (this.holderName(artifact.custody.holder) !== body.fromOrg) {
          reasons.push({
            type: "custody_mismatch",
            artifactId: id,
            holder: this.holderName(artifact.custody.holder),
            message: `器物 ${id} 现由 ${this.holderName(artifact.custody.holder)} 保管，与移交方 ${body.fromOrg} 不符`,
          });
        }
      }
      reasons.push(...this.blockIfInUse(ids));
      if (reasons.length) throw conflict("移交不能发起", reasons);

      const transferId = newTransferId();
      const event = this.record(
        "transfer_created",
        {
          transferId,
          artifactIds: ids,
          fromOrg: body.fromOrg,
          toOrg: body.toOrg,
          reason: body.reason ?? null,
          note: body.note ?? null,
        },
        actor,
      );
      return { transfer: this.transferView(this.state.transfers.get(transferId)), event };
    });
  }

  dispatchTransfer(transferId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "transfer_dispatched");
      const transfer = this.state.transfers.get(transferId);
      if (!transfer) throw notFound("移交记录", transferId);
      if (transfer.status !== "proposed") {
        throw failedPrecondition(`移交 ${transferId} 当前状态 ${transfer.status}，不能出库发运`, {
          transferId,
          status: transfer.status,
        });
      }
      validate(body, (c) => c.string(body.note, "note", "发运备注", { max: 1000 }));
      // 预生成出库事件 ID 并写入事件体：它同时是哈希链中的事件主键与交接核对码，
      // 接收方凭此码在链上定位事件、校验 prevHash 衔接。
      const eventId = newEventId();
      const event = this.record(
        "transfer_dispatched",
        { transferId, eventId, note: body.note ?? null },
        actor,
        { id: eventId },
      );
      return {
        transfer: this.transferView(this.state.transfers.get(transferId)),
        verificationCode: eventId,
        event,
      };
    });
  }

  acceptTransfer(transferId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "transfer_accepted");
      const transfer = this.state.transfers.get(transferId);
      if (!transfer) throw notFound("移交记录", transferId);
      if (transfer.status !== "in_transit") {
        throw failedPrecondition(`移交 ${transferId} 当前状态 ${transfer.status}，不能签收`, {
          transferId,
          status: transfer.status,
        });
      }
      if (!body.verificationCode) {
        throw validationFailed([{ field: "verificationCode", issue: "必须提供出库交接核对码" }]);
      }
      const dispatch = this.store
        .all()
        .find((e) => e.type === "transfer_dispatched" && e.data.transferId === transferId);
      if (body.verificationCode !== dispatch?.id) {
        throw conflict("交接核对码与出库事件不一致，拒绝签收", [
          {
            type: "verification_code_mismatch",
            provided: body.verificationCode,
            expectedEventId: dispatch?.id ?? null,
            transferId,
            message: "请凭出库回执中的核对码核对，或联系移交方重新确认哈希链",
          },
        ]);
      }
      const event = this.record(
        "transfer_accepted",
        { transferId, verificationCode: body.verificationCode, note: body.note ?? null },
        actor,
      );
      return { transfer: this.transferView(this.state.transfers.get(transferId)), event };
    });
  }

  rejectTransfer(transferId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "transfer_rejected");
      const transfer = this.state.transfers.get(transferId);
      if (!transfer) throw notFound("移交记录", transferId);
      if (transfer.status !== "in_transit") {
        throw failedPrecondition(`移交 ${transferId} 当前状态 ${transfer.status}，不能拒收退回`, {
          transferId,
          status: transfer.status,
        });
      }
      if (!body.reason) throw validationFailed([{ field: "reason", issue: "拒收必须填写原因" }]);
      const event = this.record(
        "transfer_rejected",
        { transferId, reason: body.reason, note: body.note ?? null },
        actor,
      );
      return { transfer: this.transferView(this.state.transfers.get(transferId)), event };
    });
  }

  cancelTransfer(transferId, rawBody) {
    return this.lock(() => {
      const body = rawBody ?? {};
      const actor = this.requireActor(body, "transfer_cancelled");
      const transfer = this.state.transfers.get(transferId);
      if (!transfer) throw notFound("移交记录", transferId);
      if (transfer.status !== "proposed") {
        throw failedPrecondition(`移交 ${transferId} 当前状态 ${transfer.status}，只有已发起未出库的移交可以取消`, {
          transferId,
          status: transfer.status,
        });
      }
      if (!body.reason) throw validationFailed([{ field: "reason", issue: "取消必须填写原因" }]);
      const event = this.record("transfer_cancelled", { transferId, reason: body.reason }, actor);
      return { transfer: this.transferView(this.state.transfers.get(transferId)), event };
    });
  }

  // ---- 查询 -----------------------------------------------------------

  listArtifacts(query = {}) {
    const status = query.status;
    const batchId = query.batchId;
    const q = typeof query.q === "string" ? normalizeNumber(query.q) : null;
    const items = [...this.state.artifacts.values()]
      .filter((a) => (status ? a.status === status : true))
      .filter((a) => (batchId ? a.batchId === batchId : true))
      .filter((a) => (q ? this.#artifactMatches(a, q) : true))
      .map((a) => this.artifactView(a));
    return { items, count: items.length };
  }

  #artifactMatches(artifact, normalizedQuery) {
    if (normalizeNumber(artifact.id) === normalizedQuery) return true;
    if (artifact.aliases.some((a) => a.normalized === normalizedQuery)) return true;
    if (artifact.pendingNumbers.some((p) => p.normalized === normalizedQuery)) return true;
    if (artifact.info.name && normalizeNumber(artifact.info.name).includes(normalizedQuery)) return true;
    return false;
  }

  getArtifactView(idOrNumber) {
    return this.artifactView(this.getArtifact(idOrNumber));
  }

  resolveNumber(rawNumber) {
    const key = normalizeNumber(rawNumber);
    const active = this.state.activeByNumber.get(key);
    const pending = this.state.pendingByNumber.get(key);
    if (!active && !pending) throw notFound("编号", rawNumber);
    return {
      number: rawNumber,
      normalized: key,
      resolution: active
        ? {
            kind: "registered",
            artifactId: active.artifactId,
            artifact: this.artifactView(this.state.artifacts.get(active.artifactId)),
            status: this.state.artifacts.get(active.artifactId).status,
          }
        : {
            kind: "draft_pending",
            artifactId: pending.artifactId,
            batchId: pending.batchId,
            status: "draft",
          },
    };
  }

  getBatch(batchId) {
    const batch = this.state.batches.get(batchId);
    if (!batch) throw notFound("批次", batchId);
    return this.batchView(batch);
  }
  listBatches() {
    return { items: [...this.state.batches.values()].map((b) => this.batchView(b)) };
  }

  historyOfArtifact(idOrNumber, { from, to } = {}) {
    const artifact = this.getArtifact(idOrNumber);
    const events = this.store
      .all()
      .filter((e) => relatesToArtifact(e, artifact.id))
      .filter((e) => (from ? e.at >= from : true))
      .filter((e) => (to ? e.at <= to : true));
    return {
      artifactId: artifact.id,
      status: artifact.status,
      provenance: artifact.provenance,
      events: events.map(eventView),
    };
  }

  historyOfBatch(batchId) {
    if (!this.state.batches.has(batchId)) throw notFound("批次", batchId);
    const events = this.store.all().filter((e) => e.batchId === batchId);
    return { batchId, events: events.map(eventView) };
  }

  audit(query = {}) {
    const { type, actorId, batchId, artifactId, from, to } = query;
    let { limit = 200 } = query;
    limit = Number(limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw validationFailed([{ field: "limit", issue: "limit 必须是正整数" }]);
    }
    limit = Math.min(Math.floor(limit), 1000);
    for (const [field, value] of [["from", from], ["to", to]]) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        throw validationFailed([{ field, issue: "时间必须是 ISO 8601 字符串" }]);
      }
    }
    let events = this.store.all();
    if (type) events = events.filter((e) => e.type === type);
    if (actorId) events = events.filter((e) => e.actor.id === actorId);
    if (batchId) events = events.filter((e) => e.batchId === batchId);
    if (artifactId) events = events.filter((e) => relatesToArtifact(e, artifactId));
    if (from) events = events.filter((e) => e.at >= from);
    if (to) events = events.filter((e) => e.at <= to);
    const capped = events.slice(-Number(limit));
    return {
      count: events.length,
      returned: capped.length,
      headHash: this.store.headHash(),
      events: capped.map(eventView),
    };
  }

  getTransferView(transferId) {
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) throw notFound("移交记录", transferId);
    return this.transferView(transfer);
  }

  transferPackage(transferId) {
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) throw notFound("移交记录", transferId);
    const ids = new Set(transfer.artifactIds);
    const events = this.store
      .all()
      .filter((e) => e.data?.transferId === transferId || (Array.isArray(e.data?.artifactIds) && e.data.artifactIds.some((id) => ids.has(id))));
    return {
      transfer: this.transferView(transfer),
      verificationCode: transfer.dispatchEventId,
      headHash: this.store.headHash(),
      events: events.map(eventView),
      artifacts: transfer.artifactIds.map((id) => this.artifactView(this.state.artifacts.get(id))),
      generatedAt: this.now(),
    };
  }

  // ---- 视图 -----------------------------------------------------------

  artifactView(artifact) {
    return {
      id: artifact.id,
      status: artifact.status,
      batchId: artifact.batchId,
      immutableIdentity: {
        artifactId: artifact.id,
        createdAt: artifact.createdAt,
        createdBy: artifact.createdBy,
        fingerprint: artifact.fingerprint,
      },
      info: artifact.info,
      excavation: artifact.excavation,
      photos: artifact.photos,
      storage: artifact.storage,
      appraisal: artifact.appraisal,
      numbers: {
        pending: artifact.pendingNumbers,
        aliases: artifact.aliases,
      },
      authentications: {
        currentId: artifact.currentAuthenticationId,
        versions: artifact.authentications,
      },
      custody: {
        holder: this.holderName(artifact.custody.holder),
        since: artifact.custody.since,
        transferId: artifact.custody.transferId,
      },
      activeLoanIds: artifact.activeLoanIds,
      activeExhibitionIds: artifact.activeExhibitionIds,
      lineage: {
        merge: artifact.mergeInfo,
        split: artifact.splitInfo,
        void: artifact.voidInfo,
      },
      provenance: artifact.provenance,
    };
  }

  batchView(batch) {
    return {
      id: batch.id,
      note: batch.note,
      status: batch.status,
      openedAt: batch.openedAt,
      openedBy: batch.openedBy,
      sealedAt: batch.sealedAt,
      artifacts: batch.artifactIds.map((id) => {
        const a = this.state.artifacts.get(id);
        return { id, status: a?.status ?? "unknown" };
      }),
    };
  }

  transferView(transfer) {
    return {
      ...transfer,
      verificationCode: transfer.dispatchEventId,
    };
  }
}

// ---- 模块内辅助 -------------------------------------------------------

function relatesToArtifact(event, artifactId) {
  const d = event.data ?? {};
  if (d.artifactId === artifactId || d.parentId === artifactId || d.survivorId === artifactId) return true;
  if (Array.isArray(d.artifactIds) && d.artifactIds.includes(artifactId)) return true;
  if (Array.isArray(d.sourceIds) && d.sourceIds.includes(artifactId)) return true;
  if (Array.isArray(d.children) && d.children.some((c) => c.artifactId === artifactId)) return true;
  const loan = d.loan;
  if (loan?.artifactId === artifactId) return true;
  const exhibition = d.exhibition;
  if (exhibition?.artifactId === artifactId) return true;
  return false;
}

function eventView(event) {
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    actor: event.actor,
    batchId: event.batchId,
    data: event.data,
    prevHash: event.prevHash,
    hash: event.hash,
  };
}

function pick(object, fields) {
  if (!object || typeof object !== "object") return {};
  const out = {};
  for (const field of fields) if (object[field] !== undefined) out[field] = object[field];
  return out;
}
