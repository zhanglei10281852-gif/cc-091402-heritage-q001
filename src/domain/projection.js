import { fingerprintOf, normalizeNumber } from "./identifiers.js";

// 纯函数式状态重放：当前状态不单独持久化，重启后由事件日志逐事件折叠得到。
// 任何业务读取都基于这份投影，历史则直接查询事件本身。
export function createInitialState() {
  return {
    seq: { artifact: 0, batch: 0 },
    artifacts: new Map(), // artifactId -> 聚合
    batches: new Map(), // batchId -> 批次
    pendingByNumber: new Map(), // 归一化编号 -> 草稿占用
    activeByNumber: new Map(), // 归一化编号 -> 正式别名占用
    fingerprints: new Map(), // 指纹 -> Set(artifactId)
    transfers: new Map(),
    loans: new Map(),
    exhibitions: new Map(),
  };
}

const TERMINAL = new Set(["voided", "merged", "transferred_out"]);

function indexFingerprint(state, artifact) {
  if (!TERMINAL.has(artifact.status)) {
    const set = state.fingerprints.get(artifact.fingerprint) ?? new Set();
    set.add(artifact.id);
    state.fingerprints.set(artifact.fingerprint, set);
  }
}

function unindexFingerprint(state, artifact) {
  const set = state.fingerprints.get(artifact.fingerprint);
  set?.delete(artifact.id);
}

function touchProvenance(artifact, entry) {
  artifact.provenance.push(entry);
}

export function apply(state, event) {
  const { type, at, actor, batchId, data } = event;

  switch (type) {
    case "batch_opened": {
      state.seq.batch = Math.max(state.seq.batch, data.batchSeq);
      state.batches.set(data.batchId, {
        id: data.batchId,
        seq: data.batchSeq,
        note: data.note ?? null,
        openedAt: at,
        openedBy: actor,
        status: "open",
        sealedAt: null,
        artifactIds: [],
      });
      break;
    }

    case "batch_sealed": {
      const batch = state.batches.get(batchId);
      batch.status = "sealed";
      batch.sealedAt = at;
      break;
    }

    case "artifact_created": {
      state.seq.artifact = Math.max(state.seq.artifact, data.artifactSeq);
      const artifact = {
        id: data.artifactId,
        seq: data.artifactSeq,
        status: "draft",
        batchId,
        fingerprint: data.fingerprint,
        createdAt: at,
        createdBy: actor,
        registeredAt: null,
        registeredBy: null,
        info: data.info ?? {},
        excavation: data.excavation ?? null,
        photos: [],
        storage: null,
        appraisal: null,
        pendingNumbers: [],
        aliases: [],
        authentications: [],
        currentAuthenticationId: null,
        custody: { holder: "本馆", since: at, transferId: null },
        activeLoanIds: [],
        activeExhibitionIds: [],
        loanHistory: [],
        exhibitionHistory: [],
        mergeInfo: null,
        splitInfo: null,
        voidInfo: null,
        provenance: [
          {
            at,
            kind: "created",
            actor,
            summary: "器物草稿建立，不可变身份已生成",
          },
        ],
      };
      state.artifacts.set(data.artifactId, artifact);
      state.batches.get(batchId)?.artifactIds.push(data.artifactId);
      indexFingerprint(state, artifact);
      for (const number of data.pendingNumbers ?? []) {
        const normalized = normalizeNumber(number.number);
        artifact.pendingNumbers.push({ ...number, normalized, addedAt: at, addedBy: actor });
        state.pendingByNumber.set(normalized, {
          artifactId: data.artifactId,
          number: number.number,
          namespace: number.namespace ?? "未注明",
          source: number.source ?? null,
          batchId,
        });
      }
      break;
    }

    case "number_added_pending": {
      const artifact = state.artifacts.get(data.artifactId);
      const normalized = normalizeNumber(data.number.number);
      artifact.pendingNumbers.push({
        ...data.number,
        normalized,
        addedAt: at,
        addedBy: actor,
      });
      state.pendingByNumber.set(normalized, {
        artifactId: data.artifactId,
        number: data.number.number,
        namespace: data.number.namespace ?? "未注明",
        source: data.number.source ?? null,
        batchId,
      });
      touchProvenance(artifact, {
        at,
        kind: "number_pending",
        actor,
        summary: `草稿编号待核验：${data.number.number}（${data.number.namespace ?? "未注明"}）`,
        basis: data.basis ?? null,
      });
      break;
    }

    case "draft_number_removed": {
      const artifact = state.artifacts.get(data.artifactId);
      const normalized = normalizeNumber(data.number);
      artifact.pendingNumbers = artifact.pendingNumbers.filter((p) => p.normalized !== normalized);
      state.pendingByNumber.delete(normalized);
      touchProvenance(artifact, {
        at,
        kind: "draft_number_removed",
        actor,
        summary: `移除录错的待核验编号：${data.number}；原因：${data.reason}`,
        basis: data.basis,
      });
      break;
    }

    case "artifact_registered": {
      const artifact = state.artifacts.get(data.artifactId);
      artifact.status = "registered";
      artifact.registeredAt = at;
      artifact.registeredBy = actor;
      for (const pending of artifact.pendingNumbers) {
        state.pendingByNumber.delete(pending.normalized);
        const alias = {
          number: pending.number,
          normalized: pending.normalized,
          namespace: pending.namespace ?? "未注明",
          source: pending.source ?? null,
          linkedAt: at,
          linkedBy: actor,
          status: "active",
          unlinkedAt: null,
          unlinkedBy: null,
          unlinkReason: null,
          mergedFrom: null,
        };
        artifact.aliases.push(alias);
        state.activeByNumber.set(pending.normalized, {
          artifactId: artifact.id,
          number: pending.number,
          namespace: alias.namespace,
          source: alias.source,
        });
      }
      artifact.pendingNumbers = [];
      touchProvenance(artifact, {
        at,
        kind: "registered",
        actor,
        summary: "编号核验通过，器物正式登记",
      });
      break;
    }

    case "draft_voided": {
      const artifact = state.artifacts.get(data.artifactId);
      unindexFingerprint(state, artifact);
      for (const pending of artifact.pendingNumbers) {
        state.pendingByNumber.delete(pending.normalized);
      }
      artifact.pendingNumbers = [];
      artifact.status = "voided";
      artifact.voidInfo = { at, actor, reason: data.reason, basis: data.basis };
      touchProvenance(artifact, {
        at,
        kind: "voided",
        actor,
        summary: `草稿撤销：${data.reason ?? "未填写原因"}`,
        basis: data.basis,
      });
      break;
    }

    case "artifact_number_linked": {
      const artifact = state.artifacts.get(data.artifactId);
      const normalized = normalizeNumber(data.number.number);
      const alias = {
        number: data.number.number,
        normalized,
        namespace: data.number.namespace ?? "未注明",
        source: data.number.source ?? null,
        linkedAt: at,
        linkedBy: actor,
        status: "active",
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
        mergedFrom: null,
      };
      artifact.aliases.push(alias);
      state.activeByNumber.set(normalized, {
        artifactId: artifact.id,
        number: data.number.number,
        namespace: alias.namespace,
        source: alias.source,
      });
      touchProvenance(artifact, {
        at,
        kind: "number_linked",
        actor,
        summary: `正式编号关联：${data.number.number}（${alias.namespace}）`,
        basis: data.basis,
      });
      break;
    }

    case "artifact_number_unlinked": {
      const artifact = state.artifacts.get(data.artifactId);
      const normalized = normalizeNumber(data.number);
      const alias = artifact.aliases.find(
        (item) => item.normalized === normalized && item.status === "active",
      );
      alias.status = "superseded";
      alias.unlinkedAt = at;
      alias.unlinkedBy = actor;
      alias.unlinkReason = data.reason;
      state.activeByNumber.delete(normalized);
      touchProvenance(artifact, {
        at,
        kind: "number_unlinked",
        actor,
        summary: `编号解除关联：${data.number}；原因：${data.reason}`,
        basis: data.basis,
      });
      break;
    }

    case "artifact_info_corrected": {
      const artifact = state.artifacts.get(data.artifactId);
      if (data.fields.info) artifact.info = { ...artifact.info, ...data.fields.info };
      if (data.fields.excavation) {
        artifact.excavation = { ...(artifact.excavation ?? {}), ...data.fields.excavation };
      }
      unindexFingerprint(state, artifact);
      artifact.fingerprint = fingerprintOf(artifact.info, artifact.excavation ?? {});
      indexFingerprint(state, artifact);
      touchProvenance(artifact, {
        at,
        kind: "info_corrected",
        actor,
        summary: `基本信息更正：${Object.keys(data.fields.info ?? {}).concat(Object.keys(data.fields.excavation ?? {})).join("、")}`,
        basis: data.basis,
        reason: data.reason,
      });
      break;
    }

    case "artifact_appraisal_updated": {
      const artifact = state.artifacts.get(data.artifactId);
      artifact.appraisal = { ...data.appraisal, at, by: actor };
      touchProvenance(artifact, {
        at,
        kind: "appraisal_updated",
        actor,
        summary: `保险估值更新：${data.appraisal.value} ${data.appraisal.currency}（${data.appraisal.insurer}）`,
        basis: data.appraisal.basis,
      });
      break;
    }

    case "artifact_storage_updated": {
      const artifact = state.artifacts.get(data.artifactId);
      artifact.storage = { ...data.storage, at, by: actor };
      touchProvenance(artifact, {
        at,
        kind: "storage_updated",
        actor,
        summary: `库位更新：${data.storage.location}${data.storage.shelfCode ? " / " + data.storage.shelfCode : ""}`,
      });
      break;
    }

    case "artifact_photos_updated": {
      const artifact = state.artifacts.get(data.artifactId);
      artifact.photos = data.photos.map((photo) => ({ ...photo, indexedAt: at, indexedBy: actor }));
      touchProvenance(artifact, {
        at,
        kind: "photos_updated",
        actor,
        summary: `照片索引更新，共 ${data.photos.length} 张`,
      });
      break;
    }

    case "authentication_added": {
      const artifact = state.artifacts.get(data.artifactId);
      const record = {
        id: data.authenticationId,
        at,
        by: actor,
        authenticator: data.authentication.authenticator,
        organization: data.authentication.organization ?? null,
        opinion: data.authentication.opinion,
        confidence: data.authentication.confidence ?? null,
        attaches: data.authentication.attaches ?? [],
        basis: data.authentication.basis ?? null,
        supersedes: data.supersedes ?? null,
        status: "current",
        corrections: [],
        retractedAt: null,
        retraction: null,
      };
      if (artifact.currentAuthenticationId) {
        const previous = artifact.authentications.find(
          (item) => item.id === artifact.currentAuthenticationId,
        );
        if (previous) previous.status = "superseded";
      }
      artifact.authentications.push(record);
      artifact.currentAuthenticationId = record.id;
      touchProvenance(artifact, {
        at,
        kind: "authentication_added",
        actor,
        summary: `鉴定意见录入：${record.authenticator}（${record.organization ?? "独立鉴定"}）`,
        basis: record.basis,
      });
      break;
    }

    case "authentication_corrected": {
      const artifact = state.artifacts.get(data.artifactId);
      const record = artifact.authentications.find((item) => item.id === data.authenticationId);
      record.corrections.push({
        at,
        by: actor,
        fields: data.fields,
        reason: data.reason,
        basis: data.basis,
      });
      for (const [key, value] of Object.entries(data.fields)) record[key] = value;
      touchProvenance(artifact, {
        at,
        kind: "authentication_corrected",
        actor,
        summary: `鉴定意见更正：${Object.keys(data.fields).join("、")}`,
        reason: data.reason,
        basis: data.basis,
      });
      break;
    }

    case "authentication_retracted": {
      const artifact = state.artifacts.get(data.artifactId);
      const record = artifact.authentications.find((item) => item.id === data.authenticationId);
      record.status = "retracted";
      record.retractedAt = at;
      record.retraction = { reason: data.reason, basis: data.basis, by: actor };
      if (artifact.currentAuthenticationId === record.id) {
        artifact.currentAuthenticationId = null;
      }
      touchProvenance(artifact, {
        at,
        kind: "authentication_retracted",
        actor,
        summary: `鉴定意见撤回：${data.reason}`,
        basis: data.basis,
      });
      break;
    }

    case "artifact_merged": {
      const survivor = state.artifacts.get(data.survivorId);
      for (const sourceId of data.sourceIds) {
        const source = state.artifacts.get(sourceId);
        unindexFingerprint(state, source);
        // 被并器物若尚为草稿，其待核验编号随器物一并转入幸存身份继续占用
        //（唯一索引保证同一编号不可能同时被两方占用）。
        for (const pending of source.pendingNumbers) {
          survivor.pendingNumbers.push(pending);
          state.pendingByNumber.set(pending.normalized, {
            artifactId: survivor.id,
            number: pending.number,
            namespace: pending.namespace,
            source: pending.source,
            batchId: survivor.batchId,
          });
        }
        source.pendingNumbers = [];
        // 正式编号随器物并入幸存身份，保证旧编号仍可解析。
        for (const alias of source.aliases) {
          if (alias.status === "active") {
            alias.status = "superseded";
            alias.unlinkedAt = at;
            alias.unlinkedBy = actor;
            alias.unlinkReason = `器物并入 ${data.survivorId}`;
            survivor.aliases.push({
              ...alias,
              status: "active",
              unlinkedAt: null,
              unlinkedBy: null,
              unlinkReason: null,
              mergedFrom: sourceId,
            });
            state.activeByNumber.set(alias.normalized, {
              artifactId: survivor.id,
              number: alias.number,
              namespace: alias.namespace,
              source: alias.source,
            });
          }
        }
        source.status = "merged";
        source.mergeInfo = {
          into: data.survivorId,
          at,
          by: actor,
          reason: data.reason,
          basis: data.basis,
        };
        touchProvenance(source, {
          at,
          kind: "merged_away",
          actor,
          summary: `器物并入 ${data.survivorId}：${data.reason}`,
          basis: data.basis,
        });
        touchProvenance(survivor, {
          at,
          kind: "merged_in",
          actor,
          summary: `并入器物 ${sourceId}，其正式编号已继承`,
          reason: data.reason,
          basis: data.basis,
        });
      }
      break;
    }

    case "artifact_split": {
      const parent = state.artifacts.get(data.parentId);
      unindexFingerprint(state, parent);
      // 旧身份对应的正式编号整体退出使用，由拆分子件的新编号承接。
      for (const alias of parent.aliases) {
        if (alias.status === "active") {
          alias.status = "superseded";
          alias.unlinkedAt = at;
          alias.unlinkedBy = actor;
          alias.unlinkReason = `器物拆分：${data.reason}`;
          state.activeByNumber.delete(alias.normalized);
        }
      }
      // 草稿阶段的待核验编号同样释放，由子件重新编号承接。
      for (const pending of parent.pendingNumbers) {
        state.pendingByNumber.delete(pending.normalized);
      }
      parent.pendingNumbers = [];
      parent.status = "split";
      parent.splitInfo = { at, by: actor, reason: data.reason, basis: data.basis, childIds: [] };
      touchProvenance(parent, {
        at,
        kind: "split",
        actor,
        summary: `器物拆分为 ${data.children.length} 件：${data.reason}`,
        basis: data.basis,
      });
      for (const child of data.children) {
        state.seq.artifact = Math.max(state.seq.artifact, child.artifactSeq);
        const draft = {
          id: child.artifactId,
          seq: child.artifactSeq,
          status: "draft",
          batchId: child.batchId,
          fingerprint: fingerprintOf(child.info ?? {}, parent.excavation ?? {}),
          createdAt: at,
          createdBy: actor,
          registeredAt: null,
          registeredBy: null,
          info: child.info ?? {},
          excavation: parent.excavation,
          photos: [],
          storage: parent.storage,
          appraisal: null,
          pendingNumbers: [],
          aliases: [],
          authentications: [],
          currentAuthenticationId: null,
          custody: { holder: "本馆", since: at, transferId: null },
          activeLoanIds: [],
          activeExhibitionIds: [],
          loanHistory: [],
          exhibitionHistory: [],
          mergeInfo: null,
          splitInfo: { parentId: data.parentId, at, by: actor },
          voidInfo: null,
          provenance: [
            {
              at,
              kind: "split_child",
              actor,
              summary: `由器物 ${data.parentId} 拆分而来`,
              basis: data.basis,
            },
          ],
        };
        for (const number of child.pendingNumbers ?? []) {
          const normalized = normalizeNumber(number.number);
          draft.pendingNumbers.push({ ...number, normalized, addedAt: at, addedBy: actor });
          state.pendingByNumber.set(normalized, {
            artifactId: child.artifactId,
            number: number.number,
            namespace: number.namespace ?? "未注明",
            source: number.source ?? null,
            batchId: child.batchId,
          });
        }
        state.artifacts.set(child.artifactId, draft);
        state.batches.get(child.batchId)?.artifactIds.push(child.artifactId);
        indexFingerprint(state, draft);
        parent.splitInfo.childIds.push(child.artifactId);
      }
      break;
    }

    case "transfer_created":
    case "transfer_dispatched":
    case "transfer_accepted":
    case "transfer_rejected":
    case "transfer_cancelled": {
      applyTransfer(state, event);
      break;
    }

    case "loan_opened": {
      const artifact = state.artifacts.get(data.loan.artifactId);
      state.loans.set(data.loanId, { ...data.loan, id: data.loanId, openedAt: at, openedBy: actor, status: "active", returnedAt: null });
      artifact.activeLoanIds.push(data.loanId);
      artifact.loanHistory.push({ loanId: data.loanId, at, kind: "opened" });
      touchProvenance(artifact, { at, kind: "loan_opened", actor, summary: `出借：${data.loan.borrower}` });
      break;
    }

    case "loan_returned": {
      const loan = state.loans.get(data.loanId);
      loan.status = "returned";
      loan.returnedAt = at;
      const artifact = state.artifacts.get(loan.artifactId);
      artifact.activeLoanIds = artifact.activeLoanIds.filter((id) => id !== data.loanId);
      artifact.loanHistory.push({ loanId: data.loanId, at, kind: "returned" });
      touchProvenance(artifact, { at, kind: "loan_returned", actor, summary: "出借归还" });
      break;
    }

    case "exhibition_opened": {
      const artifact = state.artifacts.get(data.exhibition.artifactId);
      state.exhibitions.set(data.exhibitionId, { ...data.exhibition, id: data.exhibitionId, openedAt: at, openedBy: actor, status: "active", closedAt: null });
      artifact.activeExhibitionIds.push(data.exhibitionId);
      artifact.exhibitionHistory.push({ exhibitionId: data.exhibitionId, at, kind: "opened" });
      touchProvenance(artifact, { at, kind: "exhibition_opened", actor, summary: `展览启用：${data.exhibition.name}` });
      break;
    }

    case "exhibition_closed": {
      const exhibition = state.exhibitions.get(data.exhibitionId);
      exhibition.status = "closed";
      exhibition.closedAt = at;
      const artifact = state.artifacts.get(exhibition.artifactId);
      artifact.activeExhibitionIds = artifact.activeExhibitionIds.filter((id) => id !== data.exhibitionId);
      artifact.exhibitionHistory.push({ exhibitionId: data.exhibitionId, at, kind: "closed" });
      touchProvenance(artifact, { at, kind: "exhibition_closed", actor, summary: "展览撤展" });
      break;
    }

    default:
      // 未知事件不致命：新版本写出的旧进程可读日志，但当前状态不含它。
      break;
  }

  return state;
}

function applyTransfer(state, event) {
  const { type, at, actor, data } = event;
  let transfer = state.transfers.get(data.transferId);

  if (type === "transfer_created") {
    transfer = {
      id: data.transferId,
      artifactIds: data.artifactIds,
      fromOrg: data.fromOrg,
      toOrg: data.toOrg,
      reason: data.reason ?? null,
      status: "proposed",
      initiatedBy: actor,
      initiatedAt: at,
      timeline: [{ at, status: "proposed", actor, note: data.note ?? null }],
      dispatchEventId: null,
      verification: null,
      rejection: null,
      cancellation: null,
    };
    state.transfers.set(data.transferId, transfer);
    for (const id of data.artifactIds) {
      touchProvenance(state.artifacts.get(id), {
        at,
        kind: "transfer_proposed",
        actor,
        summary: `发起跨馆移交：${data.fromOrg} → ${data.toOrg}`,
      });
    }
    return;
  }

  if (type === "transfer_dispatched") {
    transfer.status = "in_transit";
    transfer.dispatchEventId = data.eventId;
    transfer.timeline.push({ at, status: "in_transit", actor, note: data.note ?? null });
    for (const id of transfer.artifactIds) {
      const artifact = state.artifacts.get(id);
      artifact.custody = { holder: transfer.toOrg, since: at, transferId: transfer.id };
      touchProvenance(artifact, {
        at,
        kind: "transfer_dispatched",
        actor,
        summary: `出库发往 ${transfer.toOrg}，交接核对码见移交记录`,
      });
    }
    return;
  }

  if (type === "transfer_accepted") {
    transfer.status = "accepted";
    transfer.verification = { at, actor, code: data.verificationCode, note: data.note ?? null };
    transfer.timeline.push({ at, status: "accepted", actor, note: data.note ?? null });
    for (const id of transfer.artifactIds) {
      const artifact = state.artifacts.get(id);
      unindexFingerprint(state, artifact);
      artifact.status = "transferred_out";
      artifact.custody = { holder: transfer.toOrg, since: at, transferId: transfer.id };
      touchProvenance(artifact, {
        at,
        kind: "transfer_accepted",
        actor,
        summary: `${transfer.toOrg} 核对哈希链后签收`,
      });
    }
    return;
  }

  if (type === "transfer_rejected") {
    transfer.status = "rejected";
    transfer.rejection = { at, actor, reason: data.reason, note: data.note ?? null };
    transfer.timeline.push({ at, status: "rejected", actor, note: data.reason });
    for (const id of transfer.artifactIds) {
      const artifact = state.artifacts.get(id);
      artifact.status = "registered";
      // "本馆" 是账册内部标记，视图层解析为配置的机构名称。
      artifact.custody = { holder: "本馆", since: at, transferId: null };
      indexFingerprint(state, artifact);
      touchProvenance(artifact, {
        at,
        kind: "transfer_rejected",
        actor,
        summary: `接收方拒收并退回：${data.reason}`,
      });
    }
    return;
  }

  if (type === "transfer_cancelled") {
    transfer.status = "cancelled";
    transfer.cancellation = { at, actor, reason: data.reason };
    transfer.timeline.push({ at, status: "cancelled", actor, note: data.reason });
    for (const id of transfer.artifactIds) {
      touchProvenance(state.artifacts.get(id), {
        at,
        kind: "transfer_cancelled",
        actor,
        summary: `移交取消：${data.reason}`,
      });
    }
  }
}

// 重放整段日志，得到当前状态。
export function replay(events) {
  const state = createInitialState();
  for (const event of events) apply(state, event);
  return state;
}
