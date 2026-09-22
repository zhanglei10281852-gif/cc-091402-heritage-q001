import { randomUUID } from "node:crypto";

export const newEventId = () => `evt_${randomUUID()}`;
export const newTransferId = () => `xfer_${randomUUID()}`;
export const newLoanId = () => `loan_${randomUUID()}`;
export const newExhibitionId = () => `exh_${randomUUID()}`;

export const artifactIdOfSeq = (seq) =>
  `artifact-${String(seq).padStart(4, "0")}`;
export const batchIdOfSeq = (seq) => `batch-${String(seq).padStart(4, "0")}`;

// 编号归一化：旧纸档/临时清单/扫描记录的同一编号可能存在全半角、大小写、
// 空白差异（如 "JD-001"、"jd - 001"、"ＪＤ－００１"）。
// 严格键用于唯一索引；展示始终保留原始编号文本。
export function normalizeNumber(number) {
  return String(number)
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

// 宽松键：在严格键基础上去掉常见分隔符，仅用于"疑似同号"软冲突提示，
// 不参与唯一约束（避免把恰好只差一个连字符的两件不同器物强行合并）。
export function looseNumberKey(number) {
  return normalizeNumber(number).replace(/[\s\-_–—·.．/／]+/g, "");
}

// 疑似重复指纹：名称 + 品类 + 出土地点。仅作软冲突提示，可由经办人显式放行。
export function fingerprintOf(info = {}, excavation = {}) {
  const part = (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase();
  return [part(info.name), part(info.category), part(excavation.site)]
    .join("|");
}
