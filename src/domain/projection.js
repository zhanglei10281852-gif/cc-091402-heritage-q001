// 纯函数投影层：把账本事件依次折叠（fold）成当前状态。
// 这里不做权限或入参校验——事件一旦进入账本即视为已裁定事实；
// 所有业务规则在提交前由 HeritageService 保证。

export function createState() {
  return {
    artifacts: new Map(), // artifactId -> 器物聚合
    batches: new Map(), // batchId -> 批次视图
    identifierIndex: new Map(), // 规范化编号 -> { artifactId, value, system }
    clientRequests: new Map(), // 客户端幂等键 -> artifactId
    transfers: new Map(), // transferId -> 移交单
    eventArtifacts: new Map(), // eventId -> [artifactId...]，多器物事件的检索索引
    nextArtifactNumber: 1,
  };
}

function touch(state, event, artifactIds) {
  state.eventArtifacts.set(event.eventId, artifactIds);
}

function ensureBatch(state, batchId, event) {
  let batch = state.batches.get(batchId);
  if (!batch) {
    batch = {
      batchId,
      openedAt: event.timestamp,
      createdBy: event.operator,
      artifactIds: [],
      lastEventSeq: event.seq,
    };
    state.batches.set(batchId, batch);
  }
  batch.lastEventSeq = event.seq;
  return batch;
}

function normalizeIdentifierValue(value) {
  return String(value).trim().toUpperCase();
}

function activeIdentifiers(rec) {
  return rec.identifiers.filter((item) => item.status === "active");
}

function releaseIdentifier(state, value) {
  state.identifierIndex.delete(normalizeIdentifierValue(value));
}

function indexIdentifier(state, rec, entry, event) {
  const key = normalizeIdentifierValue(entry.value);
  state.identifierIndex.set(key, {
    artifactId: rec.id,
    value: entry.value,
    system: entry.system,
    sinceSeq: event.seq,
  });
}

function registerArtifact(state, event, data) {
  const rec = {
    id: data.artifactId,
    batchId: data.batchId,
    status: "draft",
    createdAt: event.timestamp,
    createdBy: event.operator,
    custody: "in-house", // in-house | in-transit | external
    basicInfo: data.basicInfo,
    excavation: data.excavation ?? null,
    photoIds: [...(data.photoIds ?? [])],
    identifiers: (data.identifiers ?? []).map((item) => ({
      ...item,
      status: "active",
      addedAt: event.timestamp,
      addedBy: event.operator,
      addedSeq: event.seq,
      source: item.source ?? "registration",
    })),
    identifierHistory: (data.identifiers ?? []).map((item) => ({
      ...item,
      status: "active",
      addedAt: event.timestamp,
      addedBy: event.operator,
      addedSeq: event.seq,
      source: item.source ?? "registration",
    })),
    appraisals: [],
    locations: data.location
      ? [{ location: data.location, note: null, movedAt: event.timestamp, movedBy: event.operator, seq: event.seq }]
      : [],
    currentLocation: data.location ?? null,
    provenance: [
      {
        type: data.provenance?.type ?? "registration",
        at: event.timestamp,
        detail: data.provenance ?? null,
      },
    ],
    lineage: { parents: [], children: [], mergedInto: null, splitFrom: null, splitGroup: null },
    usages: new Map(), // usageId -> 占用记录（出借/展览）
    outboundTransfers: [],
    inboundTransferId: data.provenance?.type === "transfer-in" ? data.provenance.inboundTransferId : null,
    confirmedAt: null,
    withdrawnAt: null,
    correctionCount: 0,
    lastEventSeq: event.seq,
  };
  state.artifacts.set(rec.id, rec);

  const batch = ensureBatch(state, data.batchId, event);
  batch.artifactIds.push(rec.id);

  for (const entry of rec.identifiers) indexIdentifier(state, rec, entry, event);

  if (data.clientRequestId) state.clientRequests.set(data.clientRequestId, rec.id);
  touch(state, event, [rec.id]);
  state.nextArtifactNumber = Math.max(
    state.nextArtifactNumber,
    Number.parseInt(data.artifactId.split("-")[1], 10) + 1,
  );
  return rec;
}

export function applyEvent(state, event) {
  switch (event.type) {
    case "ArtifactRegistered": {
      registerArtifact(state, event, event.data);
      break;
    }

    case "ArtifactConfirmed": {
      const rec = state.artifacts.get(event.data.artifactId);
      rec.status = "registered";
      rec.confirmedAt = event.timestamp;
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "IdentifierAdded": {
      const rec = state.artifacts.get(event.data.artifactId);
      const duplicate = activeIdentifiers(rec).some(
        (item) => normalizeIdentifierValue(item.value) === normalizeIdentifierValue(event.data.identifier.value),
      );
      const entry = {
        ...event.data.identifier,
        status: duplicate ? "duplicate" : "active",
        addedAt: event.timestamp,
        addedBy: event.operator,
        addedSeq: event.seq,
        source: event.data.identifier.source ?? "manual",
      };
      rec.identifiers.push(entry);
      rec.identifierHistory.push({ ...entry });
      if (!duplicate) indexIdentifier(state, rec, entry, event);
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "IdentifierVoided": {
      const rec = state.artifacts.get(event.data.artifactId);
      const entry = activeIdentifiers(rec).find(
        (item) => normalizeIdentifierValue(item.value) === normalizeIdentifierValue(event.data.value),
      );
      if (entry) {
        entry.status = "voided";
        entry.voidedAt = event.timestamp;
        entry.voidBasis = event.basis;
        entry.voidedBy = event.operator;
        rec.identifierHistory.push({ ...entry });
        releaseIdentifier(state, entry.value);
      }
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "InformationCorrected": {
      const rec = state.artifacts.get(event.data.artifactId);
      const patch = event.data.patch;
      if (patch.basicInfo) rec.basicInfo = { ...rec.basicInfo, ...patch.basicInfo };
      if (patch.excavation !== undefined) {
        rec.excavation = patch.excavation === null ? null : { ...(rec.excavation ?? {}), ...patch.excavation };
      }
      if (Array.isArray(patch.addPhotoIds)) rec.photoIds.push(...patch.addPhotoIds);
      if (Array.isArray(patch.removePhotoIds)) {
        const removed = new Set(patch.removePhotoIds);
        rec.photoIds = rec.photoIds.filter((id) => !removed.has(id));
      }
      rec.correctionCount += 1;
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "AppraisalAdded": {
      const rec = state.artifacts.get(event.data.artifactId);
      rec.appraisals.push({
        id: event.data.appraisalId,
        version: event.data.version,
        summary: event.data.summary,
        appraiser: event.data.appraiser,
        appraisedAt: event.data.appraisedAt,
        opinionRef: event.data.opinionRef ?? null,
        note: event.data.note ?? null,
        mergedFrom: event.data.mergedFrom ?? null,
        addedAt: event.timestamp,
        addedBy: event.operator,
        addedSeq: event.seq,
        status: "active",
      });
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "AppraisalRetracted": {
      const rec = state.artifacts.get(event.data.artifactId);
      const appraisal = rec.appraisals.find((item) => item.id === event.data.appraisalId);
      if (appraisal) {
        appraisal.status = "retracted";
        appraisal.retractedAt = event.timestamp;
        appraisal.retractBasis = event.basis;
        appraisal.retractedBy = event.operator;
      }
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "LocationMoved": {
      const rec = state.artifacts.get(event.data.artifactId);
      rec.locations.push({
        location: event.data.location,
        note: event.data.note ?? null,
        movedAt: event.timestamp,
        movedBy: event.operator,
        seq: event.seq,
      });
      rec.currentLocation = event.data.location;
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "UsageRecorded": {
      const rec = state.artifacts.get(event.data.artifactId);
      rec.usages.set(event.data.usageId, {
        usageId: event.data.usageId,
        usageType: event.data.usageType,
        ref: event.data.ref,
        note: event.data.note ?? null,
        openedAt: event.timestamp,
        openedBy: event.operator,
        status: "open",
      });
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "UsageCompleted": {
      const rec = state.artifacts.get(event.data.artifactId);
      const usage = rec.usages.get(event.data.usageId);
      if (usage) {
        usage.status = "completed";
        usage.closedAt = event.timestamp;
        usage.closedBy = event.operator;
      }
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "ArtifactWithdrawn": {
      const rec = state.artifacts.get(event.data.artifactId);
      rec.status = "withdrawn";
      rec.withdrawnAt = event.timestamp;
      rec.withdrawBasis = event.basis;
      rec.withdrawnBy = event.operator;
      // 草稿作废后，其占用的编号释放给未来登记；编号履历仍保留在事件里。
      for (const entry of activeIdentifiers(rec)) {
        entry.status = "released-with-withdrawal";
        rec.identifierHistory.push({ ...entry });
        releaseIdentifier(state, entry.value);
      }
      rec.lastEventSeq = event.seq;
      touch(state, event, [rec.id]);
      break;
    }

    case "ArtifactsMerged": {
      const { survivorId, sourceIds } = event.data;
      const survivor = state.artifacts.get(survivorId);
      const survivorValues = new Set(activeIdentifiers(survivor).map((item) => normalizeIdentifierValue(item.value)));

      for (const sourceId of sourceIds) {
        const source = state.artifacts.get(sourceId);

        // 鉴定意见随身份并入保留，标注来源，不抹除原经办人。
        for (const appraisal of source.appraisals) {
          survivor.appraisals.push({ ...appraisal, mergedFrom: sourceId });
        }
        // 照片索引合并去重。
        for (const photoId of source.photoIds) {
          if (!survivor.photoIds.includes(photoId)) survivor.photoIds.push(photoId);
        }
        // 地点轨迹并入。
        survivor.locations.push(...source.locations.map((item) => ({ ...item, mergedFrom: sourceId })));

        for (const entry of activeIdentifiers(source)) {
          releaseIdentifier(state, entry.value);
          entry.status = "moved-to:" + survivorId;
          entry.movedAt = event.timestamp;
          entry.movedSeq = event.seq;
          source.identifierHistory.push({ ...entry });
          const moved = {
            ...entry,
            status: undefined,
            source: "merge-from:" + sourceId,
            movedAt: event.timestamp,
            movedSeq: event.seq,
          };
          delete moved.status;
          if (survivorValues.has(normalizeIdentifierValue(entry.value))) {
            moved.status = "duplicate-of-survivor";
            survivor.identifierHistory.push({ ...moved });
          } else {
            moved.status = "active";
            survivor.identifiers.push(moved);
            survivor.identifierHistory.push({ ...moved });
            survivorValues.add(normalizeIdentifierValue(entry.value));
            indexIdentifier(state, survivor, moved, event);
          }
        }
        source.status = "merged";
        source.lineage.mergedInto = survivorId;
        source.mergedAt = event.timestamp;
        source.lastEventSeq = event.seq;

        survivor.lineage.parents.push(sourceId);
      }
      survivor.provenance.push({
        type: "merge",
        at: event.timestamp,
        sourceIds,
        note: event.data.note ?? null,
      });
      survivor.lastEventSeq = event.seq;
      touch(state, event, [survivorId, ...sourceIds]);
      break;
    }

    case "ArtifactSplit": {
      const { parentId, splitGroupId, children } = event.data;
      const parent = state.artifacts.get(parentId);
      parent.status = "split";
      parent.splitGroupId = splitGroupId;
      parent.splitAt = event.timestamp;
      parent.lastEventSeq = event.seq;

      const childIds = [];
      for (const childData of children) {
        const child = registerArtifact(state, event, childData);
        // registerArtifact 默认建为草稿；拆分裁定直接生效。
        child.status = "registered";
        child.confirmedAt = event.timestamp;
        child.lineage.splitFrom = parentId;
        child.lineage.splitGroup = splitGroupId;
        child.provenance = [
          {
            type: "split",
            at: event.timestamp,
            parentId,
            splitGroupId,
            note: event.data.note ?? null,
          },
        ];
        parent.lineage.children.push(child.id);
        childIds.push(child.id);
      }
      parent.provenance.push({
        type: "split",
        at: event.timestamp,
        splitGroupId,
        childIds,
        note: event.data.note ?? null,
      });
      parent.lastEventSeq = event.seq;
      touch(state, event, [parentId, ...childIds]);
      break;
    }

    case "TransferOutInitiated": {
      const { transferId, artifactIds } = event.data;
      state.transfers.set(transferId, {
        transferId,
        direction: "outbound",
        status: "pending",
        toInstitution: event.data.toInstitution,
        toContact: event.data.toContact ?? null,
        manifest: event.data.manifest,
        artifactIds: [...artifactIds],
        initiatedAt: event.timestamp,
        initiatedBy: event.operator,
        confirmedAt: null,
      });
      for (const id of artifactIds) {
        const rec = state.artifacts.get(id);
        rec.custody = "in-transit";
        rec.outboundTransfers.push(transferId);
        rec.lastEventSeq = event.seq;
      }
      touch(state, event, artifactIds);
      break;
    }

    case "TransferOutConfirmed": {
      const transfer = state.transfers.get(event.data.transferId);
      transfer.status = "completed";
      transfer.confirmedAt = event.timestamp;
      transfer.receivedBy = event.data.receivedBy;
      transfer.receiptRef = event.data.receiptRef;
      for (const id of transfer.artifactIds) {
        const rec = state.artifacts.get(id);
        rec.custody = "external";
        rec.currentLocation = transfer.toInstitution;
        rec.lastEventSeq = event.seq;
      }
      touch(state, event, transfer.artifactIds);
      break;
    }

    case "InboundTransferRecorded": {
      const { inboundTransferId, artifactIds } = event.data;
      state.transfers.set(inboundTransferId, {
        transferId: inboundTransferId,
        direction: "inbound",
        status: "completed",
        fromInstitution: event.data.fromInstitution,
        externalTransferId: event.data.externalTransferId,
        manifestFingerprint: event.data.manifestFingerprint,
        artifactIds: [...artifactIds],
        receivedAt: event.timestamp,
        receivedBy: event.operator,
        batchId: event.data.batchId,
      });
      for (const id of artifactIds) {
        const rec = state.artifacts.get(id);
        rec.custody = "in-house";
        rec.lastEventSeq = event.seq;
      }
      touch(state, event, artifactIds);
      break;
    }

    default:
      // 未知事件类型不阻断重放（账本可能由更新版本的服务写入），
      // 但指纹端点仍会覆盖它，链路可核对性不受影响。
      break;
  }
  return state;
}

export { normalizeIdentifierValue };
