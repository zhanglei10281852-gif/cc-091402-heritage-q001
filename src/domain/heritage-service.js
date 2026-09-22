import { createHash } from "node:crypto";
import { applyEvent, createState, normalizeIdentifierValue } from "./projection.js";
import { stableStringify } from "../store/event-log.js";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const USAGE_TYPES = new Set(["loan", "exhibition"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", label + " 必须是对象");
  }
  return value;
}

function validateOperator(operator) {
  requireObject(operator, "operator");
  if (!nonEmpty(operator.id) || !nonEmpty(operator.name)) {
    throw new ApiError(400, "VALIDATION_ERROR", "经办人必须包含 id 与 name");
  }
  return { id: operator.id.trim(), name: operator.name.trim(), role: operator.role ?? null };
}

function validateBasis(basis, { allowOmit = false } = {}) {
  if (basis === undefined || basis === null) {
    if (allowOmit) return null;
    throw new ApiError(400, "VALIDATION_ERROR", "每次更正/裁定必须提供依据 basis");
  }
  requireObject(basis, "basis");
  if (!nonEmpty(basis.type) || !nonEmpty(basis.summary)) {
    throw new ApiError(400, "VALIDATION_ERROR", "依据必须包含 type 与 summary");
  }
  return {
    type: basis.type.trim(),
    summary: basis.summary.trim(),
    documentRef: basis.documentRef?.trim() || null,
    at: basis.at ?? null,
  };
}

function validateIdentifiers(identifiers) {
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "至少需要提供一个来源编号");
  }
  const seen = new Set();
  return identifiers.map((item, index) => {
    requireObject(item, "identifiers[" + index + "]");
    if (!nonEmpty(item.value)) {
      throw new ApiError(400, "VALIDATION_ERROR", "identifiers[" + index + "].value 不能为空");
    }
    if (!nonEmpty(item.system)) {
      throw new ApiError(400, "VALIDATION_ERROR", "identifiers[" + index + "].system 不能为空");
    }
    const normalized = normalizeIdentifierValue(item.value);
    if (seen.has(normalized)) {
      throw new ApiError(400, "VALIDATION_ERROR", "同一次提交内编号重复：" + item.value);
    }
    seen.add(normalized);
    return {
      value: item.value.trim(),
      system: item.system.trim(),
      note: item.note?.trim() || null,
      source: item.source ?? "registration",
    };
  });
}

function validateBasicInfo(info) {
  requireObject(info, "basicInfo");
  if (!nonEmpty(info.name)) {
    throw new ApiError(400, "VALIDATION_ERROR", "器物名称 basicInfo.name 不能为空");
  }
  return {
    name: info.name.trim(),
    category: info.category?.trim() || null,
    dynasty: info.dynasty?.trim() || null,
    material: info.material?.trim() || null,
    dimensions: info.dimensions?.trim() || null,
    description: info.description?.trim() || null,
  };
}

function validateExcavation(excavation) {
  if (excavation === undefined || excavation === null) return null;
  requireObject(excavation, "excavation");
  return {
    site: excavation.site?.trim() || null,
    location: excavation.location?.trim() || null,
    excavatedAt: excavation.excavatedAt ?? null,
    context: excavation.context?.trim() || null,
    method: excavation.method?.trim() || null,
  };
}

function validateLocation(location) {
  if (location === undefined || location === null) return null;
  if (nonEmpty(location)) return { code: location.trim(), note: null };
  requireObject(location, "location");
  if (!nonEmpty(location.code)) {
    throw new ApiError(400, "VALIDATION_ERROR", "库位 location.code 不能为空");
  }
  return { code: location.code.trim(), note: location.note?.trim() || null };
}

function manifestFingerprint(manifest) {
  return createHash("sha256").update(stableStringify(manifest), "utf8").digest("hex");
}

export class HeritageService {
  constructor({ log, clock = () => new Date(), institution = { code: "MUS", name: "市级博物馆" } }) {
    this.log = log;
    this.clock = clock;
    this.institution = institution;
    this.state = createState();
    this.events = [];
    // 所有写操作排队串行执行：同批次并发录入时，编号唯一性检查与
    // 身份落盘在同一个临界区内完成，不会产生重复身份。
    this.tail = Promise.resolve();
  }

  async start() {
    this.events = await this.log.start();
    for (const event of this.events) applyEvent(this.state, event);
  }

  async close() {
    await this.log.close();
  }

  enqueue(task) {
    const run = this.tail.then(() => task());
    // 不让单个失败污染整条链。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  now() {
    return this.clock().toISOString();
  }

  // ---- 写入辅助 -------------------------------------------------------

  async commit(type, { batchId = null, operator, basis, data, timestamp }) {
    const event = await this.log.commit({
      timestamp: timestamp ?? this.now(),
      recordedAt: this.now(),
      type,
      batchId,
      operator: operator ?? null,
      basis: basis ?? null,
      data,
    });
    applyEvent(this.state, event);
    this.events.push(event);
    return event;
  }

  requireArtifact(id) {
    const rec = this.state.artifacts.get(id);
    if (!rec) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "未找到器物：" + id, { artifactId: id });
    return rec;
  }

  findIdentifierConflicts(identifiers, { ignoreArtifactId = null } = {}) {
    const conflicts = [];
    for (const entry of identifiers) {
      const hit = this.state.identifierIndex.get(normalizeIdentifierValue(entry.value));
      if (hit && hit.artifactId !== ignoreArtifactId) {
        conflicts.push({
          value: entry.value,
          system: entry.system,
          ownerArtifactId: hit.artifactId,
          ownerIdentifierSystem: hit.system,
          reason: "该编号已绑定不可变身份 " + hit.artifactId,
        });
      }
    }
    return conflicts;
  }

  allocateArtifactId() {
    const n = this.state.nextArtifactNumber;
    this.state.nextArtifactNumber += 1;
    return "artifact-" + String(n).padStart(4, "0");
  }

  ensureOpenBatch(batchId, operator) {
    if (!batchId) return "batch-" + String(this.state.batches.size + 1).padStart(4, "0");
    const batch = this.state.batches.get(batchId);
    if (batch && batch.closedAt) {
      throw new ApiError(409, "BATCH_CLOSED", "批次已关闭，不能继续录入：" + batchId, { batchId });
    }
    return batchId;
  }

  // ---- 登记与确认 -----------------------------------------------------

  async registerArtifact(input = {}) {
    return this.enqueue(() => this.#registerArtifact(input));
  }

  async #registerArtifact(input) {
    const operator = validateOperator(input.operator);
    const basicInfo = validateBasicInfo(input.basicInfo);
    const identifiers = validateIdentifiers(input.identifiers);
    const excavation = validateExcavation(input.excavation);
    const location = validateLocation(input.location);
    const photoIds = Array.isArray(input.photoIds) ? input.photoIds.map(String) : [];
    const clientRequestId = input.clientRequestId?.trim() || input.idempotencyKey?.trim() || null;
    let batchId = input.batchId?.trim() || null;

    // 客户端幂等：重试同一请求键直接返回既有身份，不产生第二条登记。
    if (clientRequestId && this.state.clientRequests.has(clientRequestId)) {
      const artifactId = this.state.clientRequests.get(clientRequestId);
      return { reused: true, artifactId, artifact: this.serializeArtifact(this.state.artifacts.get(artifactId)) };
    }

    // 并发下第二笔请求在此处被挡下，并带回足够信息让管理员复核冲突。
    const conflicts = this.findIdentifierConflicts(identifiers);
    if (conflicts.length > 0) {
      throw new ApiError(409, "IDENTIFIER_CONFLICT", "编号与已有不可变身份冲突，登记被拒绝", {
        conflicts,
        hint: "如确认为同一器物，请使用合并接口；如为旧档误植，请先作废该编号。",
      });
    }

    batchId = this.ensureOpenBatch(batchId, operator);
    const artifactId = this.allocateArtifactId();
    const event = await this.commit("ArtifactRegistered", {
      batchId,
      operator,
      basis: validateBasis(input.basis, { allowOmit: true }),
      timestamp: input.occurredAt,
      data: {
        artifactId,
        batchId,
        basicInfo,
        excavation,
        photoIds,
        identifiers,
        location,
        clientRequestId,
        provenance: input.provenance ?? null,
      },
    });
    return { reused: false, artifactId, artifact: this.serializeArtifact(this.state.artifacts.get(artifactId)), event };
  }

  async confirmArtifact(id, body = {}) {
    return this.enqueue(() => this.#confirmArtifact(id, body));
  }

  async #confirmArtifact(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    if (rec.status !== "draft") {
      throw new ApiError(409, "INVALID_STATE", "只有草稿可以确认登记，当前状态：" + rec.status, {
        artifactId: id,
        status: rec.status,
      });
    }
    const event = await this.commit("ArtifactConfirmed", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id },
    });
    return { artifactId: id, status: "registered", event };
  }

  // ---- 编号管理 -------------------------------------------------------

  async addIdentifier(id, body = {}) {
    return this.enqueue(() => this.#addIdentifier(id, body));
  }

  async #addIdentifier(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    const identifiers = validateIdentifiers([body.identifier ?? body]);
    const entry = { ...identifiers[0], source: identifiers[0].source === "registration" ? "manual" : identifiers[0].source };

    const owner = this.state.identifierIndex.get(normalizeIdentifierValue(entry.value));
    if (owner) {
      throw new ApiError(409, "IDENTIFIER_CONFLICT", "编号已被其他不可变身份占用", {
        value: entry.value,
        ownerArtifactId: owner.artifactId,
        ownerIdentifierSystem: owner.system,
        hint: owner.artifactId === id
          ? "该编号已在此器物上，请勿重复添加"
          : "如两件器物实为一件，请走合并流程",
      });
    }
    const event = await this.commit("IdentifierAdded", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, identifier: entry },
    });
    return { artifactId: id, identifier: event.data.identifier, event };
  }

  async voidIdentifier(id, body = {}) {
    return this.enqueue(() => this.#voidIdentifier(id, body));
  }

  async #voidIdentifier(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    if (!nonEmpty(body.value)) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供要作废的编号 value");
    }
    const active = rec.identifiers.find(
      (item) => item.status === "active" && normalizeIdentifierValue(item.value) === normalizeIdentifierValue(body.value),
    );
    if (!active) {
      throw new ApiError(404, "IDENTIFIER_NOT_ACTIVE", "该器物上没有处于有效状态的编号：" + body.value, {
        artifactId: id,
        value: body.value,
      });
    }
    const event = await this.commit("IdentifierVoided", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, value: active.value },
    });
    return { artifactId: id, voided: active.value, event };
  }

  // ---- 信息更正 -------------------------------------------------------

  async correctInformation(id, body = {}) {
    return this.enqueue(() => this.#correctInformation(id, body));
  }

  async #correctInformation(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    if (["withdrawn", "merged", "split"].includes(rec.status)) {
      throw new ApiError(409, "INVALID_STATE", "已" + rec.status + " 的身份不能再更正，请在存续身份上操作", {
        artifactId: id,
        status: rec.status,
      });
    }
    const patchBody = requireObject(body.patch ?? {}, "patch");
    const patch = {};
    if (patchBody.basicInfo !== undefined) patch.basicInfo = validateBasicInfo({ ...rec.basicInfo, ...patchBody.basicInfo });
    if (patchBody.excavation !== undefined) {
      patch.excavation =
        patchBody.excavation === null
          ? null
          : validateExcavation({ ...(rec.excavation ?? {}), ...patchBody.excavation });
    }
    if (patchBody.addPhotoIds !== undefined) {
      if (!Array.isArray(patchBody.addPhotoIds)) {
        throw new ApiError(400, "VALIDATION_ERROR", "addPhotoIds 必须是数组");
      }
      patch.addPhotoIds = [...new Set(patchBody.addPhotoIds.map(String))].filter((photoId) => !rec.photoIds.includes(photoId));
    }
    if (patchBody.removePhotoIds !== undefined) {
      if (!Array.isArray(patchBody.removePhotoIds)) {
        throw new ApiError(400, "VALIDATION_ERROR", "removePhotoIds 必须是数组");
      }
      patch.removePhotoIds = patchBody.removePhotoIds.map(String);
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "没有可更正的字段（basicInfo/excavation/addPhotoIds/removePhotoIds）");
    }
    const event = await this.commit("InformationCorrected", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, patch },
    });
    return { artifactId: id, artifact: this.serializeArtifact(rec), event };
  }

  // ---- 鉴定意见版本 ---------------------------------------------------

  async addAppraisal(id, body = {}) {
    return this.enqueue(() => this.#addAppraisal(id, body));
  }

  async #addAppraisal(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis, { allowOmit: true });
    const rec = this.requireArtifact(id);
    if (["withdrawn", "merged", "split"].includes(rec.status)) {
      throw new ApiError(409, "INVALID_STATE", "已" + rec.status + " 的身份不能再添加鉴定意见", {
        artifactId: id,
        status: rec.status,
      });
    }
    if (!nonEmpty(body.summary)) {
      throw new ApiError(400, "VALIDATION_ERROR", "鉴定意见 summary 不能为空");
    }
    requireObject(body.appraiser ?? null, "appraiser");
    if (!nonEmpty(body.appraiser?.name)) {
      throw new ApiError(400, "VALIDATION_ERROR", "鉴定人 appraiser.name 不能为空");
    }
    const activeAppraisals = rec.appraisals.filter((item) => item.status === "active");
    const appraisalId = "apr-" + String(rec.appraisals.length + 1).padStart(4, "0") + "-" + id.split("-")[1];
    const version = Number.isInteger(body.version) ? body.version : activeAppraisals.length + 1;
    if (rec.appraisals.some((item) => item.version === version)) {
      throw new ApiError(409, "APPRAISAL_VERSION_EXISTS", "鉴定版本号已被使用：v" + version, {
        artifactId: id,
        version,
        usedVersions: rec.appraisals.map((item) => ({ version: item.version, status: item.status })),
      });
    }
    const event = await this.commit("AppraisalAdded", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        artifactId: id,
        appraisalId,
        version,
        summary: body.summary.trim(),
        appraiser: {
          name: body.appraiser.name.trim(),
          org: body.appraiser.org?.trim() || null,
          title: body.appraiser.title?.trim() || null,
        },
        appraisedAt: body.appraisedAt ?? this.now(),
        opinionRef: body.opinionRef?.trim() || null,
        note: body.note?.trim() || null,
      },
    });
    return { artifactId: id, appraisal: rec.appraisals.find((item) => item.id === appraisalId), event };
  }

  async retractAppraisal(id, appraisalId, body = {}) {
    return this.enqueue(() => this.#retractAppraisal(id, appraisalId, body));
  }

  async #retractAppraisal(id, appraisalId, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    const appraisal = rec.appraisals.find((item) => item.id === appraisalId);
    if (!appraisal) {
      throw new ApiError(404, "APPRAISAL_NOT_FOUND", "未找到鉴定意见：" + appraisalId, { artifactId: id, appraisalId });
    }
    if (appraisal.status !== "active") {
      throw new ApiError(409, "INVALID_STATE", "只能撤销生效中的鉴定意见，当前状态：" + appraisal.status, {
        appraisalId,
        status: appraisal.status,
      });
    }
    const event = await this.commit("AppraisalRetracted", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, appraisalId },
    });
    return { artifactId: id, appraisalId, status: "retracted", event };
  }

  // ---- 库位 -----------------------------------------------------------

  async moveLocation(id, body = {}) {
    return this.enqueue(() => this.#moveLocation(id, body));
  }

  async #moveLocation(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis, { allowOmit: true });
    const rec = this.requireArtifact(id);
    const location = validateLocation(body.location);
    if (!location) throw new ApiError(400, "VALIDATION_ERROR", "必须提供目标库位 location");
    const event = await this.commit("LocationMoved", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, location, note: body.note?.trim() || null },
    });
    return { artifactId: id, currentLocation: location, event };
  }

  // ---- 出借 / 展览占用（决定草稿能否撤销） -----------------------------

  async recordUsage(id, body = {}) {
    return this.enqueue(() => this.#recordUsage(id, body));
  }

  async #recordUsage(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis, { allowOmit: true });
    const rec = this.requireArtifact(id);
    if (!USAGE_TYPES.has(body.usageType)) {
      throw new ApiError(400, "VALIDATION_ERROR", "usageType 必须是 loan 或 exhibition");
    }
    if (!nonEmpty(body.ref)) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供出借/展览单号 ref");
    }
    // 草稿也可能被展览计划或拟出借单提前引用；一旦存在这种占用，
    // 撤销就必须被阻止——这正是"撤销只影响尚未用于出借或展览的草稿"。
    if (!["draft", "registered"].includes(rec.status)) {
      throw new ApiError(409, "INVALID_STATE", "当前状态不能登记出借/展览：" + rec.status, {
        artifactId: id,
        status: rec.status,
      });
    }
    if (rec.custody !== "in-house") {
      throw new ApiError(409, "NOT_IN_CUSTODY", "器物不在本馆保管中，不能登记出借/展览", {
        artifactId: id,
        custody: rec.custody,
      });
    }
    const usageId = body.usageId?.trim() || "use-" + String(rec.usages.size + 1).padStart(4, "0") + "-" + id.split("-")[1];
    if ([...rec.usages.values()].some((usage) => usage.usageId === usageId)) {
      throw new ApiError(409, "USAGE_EXISTS", "占用记录已存在：" + usageId, { usageId });
    }
    const event = await this.commit("UsageRecorded", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        artifactId: id,
        usageId,
        usageType: body.usageType,
        ref: body.ref.trim(),
        note: body.note?.trim() || null,
      },
    });
    return { artifactId: id, usage: rec.usages.get(usageId), event };
  }

  async completeUsage(id, usageId, body = {}) {
    return this.enqueue(() => this.#completeUsage(id, usageId, body));
  }

  async #completeUsage(id, usageId, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis, { allowOmit: true });
    const rec = this.requireArtifact(id);
    const usage = rec.usages.get(usageId);
    if (!usage) throw new ApiError(404, "USAGE_NOT_FOUND", "未找到占用记录：" + usageId, { artifactId: id, usageId });
    if (usage.status !== "open") {
      throw new ApiError(409, "INVALID_STATE", "占用记录已结束", { usageId, status: usage.status });
    }
    const event = await this.commit("UsageCompleted", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, usageId },
    });
    return { artifactId: id, usage: rec.usages.get(usageId), event };
  }

  // ---- 撤销（仅限未被出借或展览使用的草稿） -----------------------------

  async withdrawArtifact(id, body = {}) {
    return this.enqueue(() => this.#withdrawArtifact(id, body));
  }

  async #withdrawArtifact(id, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const rec = this.requireArtifact(id);
    if (rec.status !== "draft") {
      throw new ApiError(409, "WITHDRAW_DRAFT_ONLY", "撤销只影响草稿，当前状态：" + rec.status, {
        artifactId: id,
        status: rec.status,
      });
    }
    // 只要草稿曾被出借或展览引用（无论占用是否已结束），都不允许撤销：
    // 撤销只影响尚未用于出借或展览的草稿。
    if (rec.usages.size > 0) {
      throw new ApiError(409, "ARTIFACT_IN_USE", "草稿已用于出借或展览，不能撤销；如需更正请走更正流程", {
        artifactId: id,
        usages: [...rec.usages.values()].map((usage) => ({
          usageId: usage.usageId,
          usageType: usage.usageType,
          ref: usage.ref,
          status: usage.status,
        })),
      });
    }
    const event = await this.commit("ArtifactWithdrawn", {
      batchId: rec.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { artifactId: id, reason: body.reason?.trim() || null },
    });
    return { artifactId: id, status: "withdrawn", event };
  }

  // ---- 合并 -----------------------------------------------------------

  async mergeArtifacts(body = {}) {
    return this.enqueue(() => this.#mergeArtifacts(body));
  }

  async #mergeArtifacts(body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const survivorId = body.survivorId?.trim();
    const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [];
    if (!survivorId || sourceIds.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供 survivorId 与至少一个 sourceIds");
    }
    if (new Set([survivorId, ...sourceIds]).size !== sourceIds.length + 1) {
      throw new ApiError(400, "VALIDATION_ERROR", "合并各方身份不能重复");
    }
    const survivor = this.requireArtifact(survivorId);
    const sources = sourceIds.map((id) => this.requireArtifact(id));

    const blockers = [];
    for (const rec of [survivor, ...sources]) {
      if (rec.status !== "registered") {
        blockers.push({ artifactId: rec.id, reason: "状态不是已确认登记（" + rec.status + "）" });
      }
      if (rec.custody !== "in-house") {
        blockers.push({ artifactId: rec.id, reason: "不在本馆保管中（" + rec.custody + "）" });
      }
      const openUsages = [...rec.usages.values()].filter((usage) => usage.status === "open");
      if (openUsages.length > 0) {
        blockers.push({
          artifactId: rec.id,
          reason: "存在未结束的出借/展览",
          usages: openUsages.map((usage) => ({ usageId: usage.usageId, ref: usage.ref })),
        });
      }
    }
    if (blockers.length > 0) {
      throw new ApiError(409, "MERGE_BLOCKED", "存在不能合并的身份，请先处理下列事项", { blockers });
    }

    const event = await this.commit("ArtifactsMerged", {
      batchId: survivor.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        survivorId,
        sourceIds,
        note: body.note?.trim() || null,
      },
    });
    return {
      survivorId,
      survivor: this.serializeArtifact(survivor),
      merged: sources.map((rec) => ({ artifactId: rec.id, status: rec.status, mergedInto: rec.lineage.mergedInto })),
      event,
    };
  }

  // ---- 拆分 -----------------------------------------------------------

  async splitArtifact(parentId, body = {}) {
    return this.enqueue(() => this.#splitArtifact(parentId, body));
  }

  async #splitArtifact(parentId, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const parent = this.requireArtifact(parentId);
    if (parent.status !== "registered") {
      throw new ApiError(409, "INVALID_STATE", "只有已确认登记的器物可以拆分，当前状态：" + parent.status, {
        artifactId: parentId,
        status: parent.status,
      });
    }
    if (parent.custody !== "in-house") {
      throw new ApiError(409, "NOT_IN_CUSTODY", "器物不在本馆保管中，不能拆分", { artifactId: parentId });
    }
    const openUsages = [...parent.usages.values()].filter((usage) => usage.status === "open");
    if (openUsages.length > 0) {
      throw new ApiError(409, "ARTIFACT_IN_USE", "器物仍在出借/展览中，不能拆分", {
        artifactId: parentId,
        usages: openUsages.map((usage) => ({ usageId: usage.usageId, ref: usage.ref })),
      });
    }
    if (!Array.isArray(body.children) || body.children.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "拆分至少要登记一个子身份 children[]");
    }

    // 先完成全部校验再落任何事件，保证拆分要么整体生效，要么整体不动。
    const childSpecs = body.children.map((child, index) => {
      requireObject(child, "children[" + index + "]");
      return {
        basicInfo: validateBasicInfo(child.basicInfo ?? { name: parent.basicInfo.name, category: parent.basicInfo.category }),
        identifiers: validateIdentifiers(child.identifiers),
        excavation: validateExcavation(child.excavation),
        location: validateLocation(child.location),
        photoIds: Array.isArray(child.photoIds) ? child.photoIds.map(String) : [],
        note: child.note?.trim() || null,
      };
    });
    const allConflicts = childSpecs.flatMap((spec) => this.findIdentifierConflicts(spec.identifiers));
    if (allConflicts.length > 0) {
      throw new ApiError(409, "IDENTIFIER_CONFLICT", "拆分产生的新身份编号与现有身份冲突", { conflicts: allConflicts });
    }

    const splitGroupId =
      body.splitGroupId?.trim() ||
      "split-" + parentId + "-" + String(this.events.length + 1).padStart(6, "0");
    const children = childSpecs.map((spec) => ({
      artifactId: this.allocateArtifactId(),
      batchId: parent.batchId,
      basicInfo: spec.basicInfo,
      excavation: spec.excavation,
      photoIds: spec.photoIds,
      identifiers: spec.identifiers,
      location: spec.location,
      clientRequestId: null,
      provenance: { type: "split", parentId, splitGroupId, note: spec.note },
    }));

    const event = await this.commit("ArtifactSplit", {
      batchId: parent.batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: { parentId, splitGroupId, children, note: body.note?.trim() || null },
    });
    const childIds = children.map((child) => child.artifactId);
    return { parentId, splitGroupId, childIds, children: childIds.map((id) => this.serializeArtifact(this.state.artifacts.get(id))), event };
  }

  // ---- 跨馆移交 -------------------------------------------------------

  #buildManifest(artifactIds) {
    return artifactIds
      .map((id) => {
        const rec = this.state.artifacts.get(id);
        return {
          artifactId: id,
          name: rec.basicInfo.name,
          identifiers: rec.identifiers
            .filter((item) => item.status === "active")
            .map((item) => ({ value: item.value, system: item.system })),
          photoIds: [...rec.photoIds],
        };
      })
      .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  }

  async initiateTransferOut(body = {}) {
    return this.enqueue(() => this.#initiateTransferOut(body));
  }

  async #initiateTransferOut(body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    if (!nonEmpty(body.toInstitution)) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供接收机构 toInstitution");
    }
    const artifactIds = Array.isArray(body.artifactIds) ? body.artifactIds.map(String) : [];
    if (artifactIds.length === 0) throw new ApiError(400, "VALIDATION_ERROR", "移交清单 artifactIds 不能为空");
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new ApiError(400, "VALIDATION_ERROR", "移交清单内器物重复");
    }
    const records = artifactIds.map((id) => this.requireArtifact(id));
    const blockers = [];
    for (const rec of records) {
      if (rec.status !== "registered") blockers.push({ artifactId: rec.id, reason: "状态为 " + rec.status + "，不能移交" });
      if (rec.custody !== "in-house") blockers.push({ artifactId: rec.id, reason: "保管状态为 " + rec.custody });
      const openUsages = [...rec.usages.values()].filter((usage) => usage.status === "open");
      if (openUsages.length > 0) {
        blockers.push({
          artifactId: rec.id,
          reason: "存在未结束的出借/展览",
          usages: openUsages.map((usage) => ({ usageId: usage.usageId, ref: usage.ref })),
        });
      }
    }
    if (blockers.length > 0) {
      throw new ApiError(409, "TRANSFER_BLOCKED", "移交被阻止，请先处理下列事项", { blockers });
    }

    const transferId = body.transferId?.trim() || "trf-" + String(this.state.transfers.size + 1).padStart(4, "0");
    if (this.state.transfers.has(transferId)) {
      throw new ApiError(409, "TRANSFER_EXISTS", "移交单已存在：" + transferId, { transferId });
    }
    const manifest = this.#buildManifest(artifactIds);
    const fingerprint = manifestFingerprint({
      fromInstitution: this.institution,
      toInstitution: body.toInstitution.trim(),
      transferId,
      manifest,
    });
    const event = await this.commit("TransferOutInitiated", {
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        transferId,
        artifactIds,
        toInstitution: body.toInstitution.trim(),
        toContact: body.toContact?.trim() || null,
        manifest,
        manifestFingerprint: fingerprint,
        note: body.note?.trim() || null,
      },
    });
    return { transfer: this.serializeTransfer(this.state.transfers.get(transferId)), manifestFingerprint: fingerprint, event };
  }

  async confirmTransferOut(transferId, body = {}) {
    return this.enqueue(() => this.#confirmTransferOut(transferId, body));
  }

  async #confirmTransferOut(transferId, body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    const transfer = this.state.transfers.get(transferId);
    if (!transfer) throw new ApiError(404, "TRANSFER_NOT_FOUND", "未找到移交单：" + transferId, { transferId });
    if (transfer.direction !== "outbound" || transfer.status !== "pending") {
      throw new ApiError(409, "INVALID_STATE", "移交单当前状态不能确认：" + transfer.status, {
        transferId,
        status: transfer.status,
      });
    }
    if (!nonEmpty(body.receiptRef)) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供对方签收凭据 receiptRef");
    }
    const event = await this.commit("TransferOutConfirmed", {
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        transferId,
        receivedBy: nonEmpty(body.receivedBy) ? body.receivedBy.trim() : null,
        receiptRef: body.receiptRef.trim(),
      },
    });
    return { transfer: this.serializeTransfer(this.state.transfers.get(transferId)), event };
  }

  async recordInboundTransfer(body = {}) {
    return this.enqueue(() => this.#recordInboundTransfer(body));
  }

  async #recordInboundTransfer(body) {
    const operator = validateOperator(body.operator);
    const basis = validateBasis(body.basis);
    if (!nonEmpty(body.fromInstitution)) {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供移交机构 fromInstitution");
    }
    if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "入库清单 artifacts 不能为空");
    }

    // 整批先校验：任一编号冲突则整批不入库，避免半成品批次。
    const specs = body.artifacts.map((item, index) => {
      requireObject(item, "artifacts[" + index + "]");
      return {
        basicInfo: validateBasicInfo(item.basicInfo),
        identifiers: validateIdentifiers(item.identifiers),
        excavation: validateExcavation(item.excavation),
        location: validateLocation(item.location),
        photoIds: Array.isArray(item.photoIds) ? item.photoIds.map(String) : [],
      };
    });
    const seenInBatch = new Set();
    const conflicts = [];
    for (const spec of specs) {
      for (const entry of spec.identifiers) {
        const key = normalizeIdentifierValue(entry.value);
        if (seenInBatch.has(key)) conflicts.push({ value: entry.value, reason: "移交清单内部编号重复" });
        seenInBatch.add(key);
      }
      conflicts.push(...this.findIdentifierConflicts(spec.identifiers));
    }
    if (conflicts.length > 0) {
      throw new ApiError(409, "IDENTIFIER_CONFLICT", "移交入库编号与本馆身份冲突，整批拒绝", { conflicts });
    }

    const batchId = this.ensureOpenBatch(body.batchId?.trim() || null, operator);
    const inboundTransferId =
      body.inboundTransferId?.trim() || "trf-in-" + String(this.state.transfers.size + 1).padStart(4, "0");
    const artifactIds = [];
    const registerEvents = [];

    for (const spec of specs) {
      const artifactId = this.allocateArtifactId();
      artifactIds.push(artifactId);
      const event = await this.commit("ArtifactRegistered", {
        batchId,
        operator,
        basis,
        timestamp: body.occurredAt,
        data: {
          artifactId,
          batchId,
          basicInfo: spec.basicInfo,
          excavation: spec.excavation,
          photoIds: spec.photoIds,
          identifiers: spec.identifiers,
          location: spec.location,
          clientRequestId: null,
          provenance: {
            type: "transfer-in",
            fromInstitution: body.fromInstitution.trim(),
            externalTransferId: body.externalTransferId?.trim() || null,
            inboundTransferId,
          },
        },
      });
      registerEvents.push(event);
    }

    const event = await this.commit("InboundTransferRecorded", {
      batchId,
      operator,
      basis,
      timestamp: body.occurredAt,
      data: {
        inboundTransferId,
        batchId,
        fromInstitution: body.fromInstitution.trim(),
        externalTransferId: body.externalTransferId?.trim() || null,
        manifestFingerprint: body.manifestFingerprint?.trim() || null,
        artifactIds,
      },
    });
    return {
      inboundTransferId,
      batchId,
      artifactIds,
      transfer: this.serializeTransfer(this.state.transfers.get(inboundTransferId)),
      events: [...registerEvents, event],
    };
  }

  /** 用对方出具的清单指纹核对入库记录。 */
  verifyInboundManifest(inboundTransferId, expectedFingerprint) {
    const transfer = this.state.transfers.get(inboundTransferId);
    if (!transfer) {
      throw new ApiError(404, "TRANSFER_NOT_FOUND", "未找到移交单：" + inboundTransferId, { inboundTransferId });
    }
    if (!transfer.manifestFingerprint) {
      throw new ApiError(422, "NO_FINGERPRINT_RECORDED", "入库时未登记对方清单指纹，无法核对", { inboundTransferId });
    }
    const matches = transfer.manifestFingerprint === String(expectedFingerprint).trim();
    return {
      inboundTransferId,
      matches,
      recordedFingerprint: transfer.manifestFingerprint,
      providedFingerprint: String(expectedFingerprint).trim(),
    };
  }

  // ---- 查询 -----------------------------------------------------------

  serializeArtifact(rec) {
    return {
      id: rec.id,
      batchId: rec.batchId,
      status: rec.status,
      custody: rec.custody,
      basicInfo: rec.basicInfo,
      excavation: rec.excavation,
      photoIds: [...rec.photoIds],
      currentLocation: rec.currentLocation,
      identifiers: rec.identifiers.map((item) => ({ ...item })),
      appraisals: rec.appraisals.map((item) => ({ ...item })),
      locationHistory: rec.locations.map((item) => ({ ...item })),
      usages: [...rec.usages.values()].map((item) => ({ ...item })),
      lineage: { ...rec.lineage },
      provenance: rec.provenance.map((item) => ({ ...item })),
      inboundTransferId: rec.inboundTransferId,
      outboundTransfers: [...rec.outboundTransfers],
      createdAt: rec.createdAt,
      createdBy: rec.createdBy,
      confirmedAt: rec.confirmedAt,
      withdrawnAt: rec.withdrawnAt,
      correctionCount: rec.correctionCount,
      lastEventSeq: rec.lastEventSeq,
    };
  }

  serializeTransfer(transfer) {
    return {
      ...transfer,
      manifestFingerprint: transfer.manifestFingerprint ?? null,
    };
  }

  listArtifacts({ status, batchId, custody, q } = {}) {
    let records = [...this.state.artifacts.values()];
    if (status) records = records.filter((rec) => rec.status === status);
    if (custody) records = records.filter((rec) => rec.custody === custody);
    if (batchId) records = records.filter((rec) => rec.batchId === batchId);
    if (q) {
      const needle = q.trim().toUpperCase();
      records = records.filter(
        (rec) =>
          rec.basicInfo.name.toUpperCase().includes(needle) ||
          rec.identifiers.some((item) => normalizeIdentifierValue(item.value).includes(needle)),
      );
    }
    return records.map((rec) => ({
      id: rec.id,
      name: rec.basicInfo.name,
      status: rec.status,
      custody: rec.custody,
      batchId: rec.batchId,
      currentLocation: rec.currentLocation,
      identifiers: rec.identifiers.filter((item) => item.status === "active").map((item) => ({ value: item.value, system: item.system })),
      lastEventSeq: rec.lastEventSeq,
    }));
  }

  getArtifact(id) {
    return this.serializeArtifact(this.requireArtifact(id));
  }

  resolveIdentifier(value) {
    if (!nonEmpty(value)) throw new ApiError(400, "VALIDATION_ERROR", "必须提供待查编号");
    const key = normalizeIdentifierValue(value);
    const active = this.state.identifierIndex.get(key);
    if (active) {
      const rec = this.state.artifacts.get(active.artifactId);
      return {
        query: value,
        resolved: true,
        artifactId: active.artifactId,
        ownerStatus: rec.status,
        identifierSystem: active.system,
        name: rec.basicInfo.name,
      };
    }
    // 失效编号也要能查到去向，方便复核旧纸档。
    const history = [];
    for (const rec of this.state.artifacts.values()) {
      for (const entry of rec.identifierHistory) {
        if (normalizeIdentifierValue(entry.value) === key && entry.status !== "active") {
          history.push({
            artifactId: rec.id,
            system: entry.system,
            status: entry.status,
            addedSeq: entry.addedSeq,
            movedSeq: entry.movedSeq ?? null,
            note: entry.note ?? null,
          });
        }
      }
    }
    return { query: value, resolved: false, history };
  }

  getBatch(batchId) {
    const batch = this.state.batches.get(batchId);
    if (!batch) throw new ApiError(404, "BATCH_NOT_FOUND", "未找到批次：" + batchId, { batchId });
    return {
      ...batch,
      artifacts: batch.artifactIds.map((id) => {
        const rec = this.state.artifacts.get(id);
        return {
          id,
          name: rec.basicInfo.name,
          status: rec.status,
          custody: rec.custody,
          identifiers: rec.identifiers.filter((item) => item.status === "active").map((item) => item.value),
        };
      }),
    };
  }

  listBatches() {
    return [...this.state.batches.values()].map((batch) => ({
      batchId: batch.batchId,
      openedAt: batch.openedAt,
      createdBy: batch.createdBy,
      artifactCount: batch.artifactIds.length,
      lastEventSeq: batch.lastEventSeq,
    }));
  }

  #eventView(event) {
    return {
      seq: event.seq,
      eventId: event.eventId,
      type: event.type,
      timestamp: event.timestamp,
      recordedAt: event.recordedAt,
      batchId: event.batchId,
      operator: event.operator,
      basis: event.basis,
      data: event.data,
      prevHash: event.prevHash,
      hash: event.hash,
    };
  }

  getArtifactHistory(id) {
    this.requireArtifact(id);
    const eventIds = this.state.eventArtifacts;
    const events = this.events
      .filter((event) => {
        const ids = eventIds.get(event.eventId);
        return ids && ids.includes(id);
      })
      .map((event) => this.#eventView(event));
    return { artifactId: id, events };
  }

  getLineage(id) {
    this.requireArtifact(id);
    const nodes = new Map();
    const edges = [];
    const visit = (currentId) => {
      if (nodes.has(currentId)) return;
      const rec = this.state.artifacts.get(currentId);
      if (!rec) return;
      nodes.set(currentId, {
        artifactId: currentId,
        name: rec.basicInfo.name,
        status: rec.status,
        custody: rec.custody,
      });
      if (rec.lineage.mergedInto) {
        edges.push({ from: currentId, to: rec.lineage.mergedInto, relation: "merged-into" });
        visit(rec.lineage.mergedInto);
      }
      for (const parentId of rec.lineage.parents) {
        edges.push({ from: parentId, to: currentId, relation: "merged-into" });
        visit(parentId);
      }
      if (rec.lineage.splitFrom) {
        edges.push({ from: rec.lineage.splitFrom, to: currentId, relation: "split-into" });
        visit(rec.lineage.splitFrom);
      }
      for (const childId of rec.lineage.children) {
        edges.push({ from: currentId, to: childId, relation: "split-into" });
        visit(childId);
      }
    };
    visit(id);
    return { rootArtifactId: id, nodes: [...nodes.values()], edges };
  }

  queryAuditEvents({ type, batchId, artifactId, from, to, afterSeq, limit = 100 } = {}) {
    let events = this.events;
    if (type) events = events.filter((event) => event.type === type);
    if (batchId) events = events.filter((event) => event.batchId === batchId);
    if (artifactId) {
      events = events.filter((event) => {
        const ids = this.state.eventArtifacts.get(event.eventId);
        return ids && ids.includes(artifactId);
      });
    }
    if (from) events = events.filter((event) => event.timestamp >= from);
    if (to) events = events.filter((event) => event.timestamp <= to);
    if (afterSeq) events = events.filter((event) => event.seq > Number(afterSeq));
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const slice = events.slice(0, capped).map((event) => this.#eventView(event));
    return {
      count: slice.length,
      totalMatched: events.length,
      headSeq: this.log.seq,
      headHash: this.log.headHash,
      events: slice,
    };
  }

  getTransfer(id) {
    const transfer = this.state.transfers.get(id);
    if (!transfer) throw new ApiError(404, "TRANSFER_NOT_FOUND", "未找到移交单：" + id, { transferId: id });
    return this.serializeTransfer(transfer);
  }

  listTransfers() {
    return [...this.state.transfers.values()].map((transfer) => this.serializeTransfer(transfer));
  }

  chainStatus() {
    return {
      institution: this.institution,
      eventCount: this.events.length,
      headSeq: this.log.seq,
      headHash: this.log.headHash,
      verified: true,
    };
  }
}
