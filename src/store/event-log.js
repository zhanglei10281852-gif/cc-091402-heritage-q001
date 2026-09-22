import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// 账本版本：哈希算法或信封结构变更时递增，使旧链仍可被识别。
const LEDGER_VERSION = 1;

/**
 * 账本被篡改或损坏时抛出。服务在启动阶段遇到该错误应拒绝写入，
 * 避免在不可信的状态上继续出具登记结论。
 */
export class LedgerTamperedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "LedgerTamperedError";
    this.code = "LEDGER_TAMPERED";
    this.details = details;
  }
}

/**
 * 规范化序列化：对象键按字典序排列，确保同一条事件在任何机器、
 * 任何进程里算出的哈希一致，跨馆核对时双方才能得到同一指纹。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
      .join(",") +
    "}"
  );
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 计算事件哈希。哈希内容覆盖事件的全部业务要素与上一条事件哈希，
 * 形成逐条咬合的链：任何一行被增删改，之后所有指纹都会失配。
 */
export function hashEvent(prevHash, fields) {
  return sha256(
    stableStringify({
      v: LEDGER_VERSION,
      seq: fields.seq,
      eventId: fields.eventId,
      timestamp: fields.timestamp,
      recordedAt: fields.recordedAt,
      type: fields.type,
      batchId: fields.batchId,
      operator: fields.operator,
      basis: fields.basis,
      data: fields.data,
      prevHash,
    }),
  );
}

/**
 * 仅追加（append-only）事件账本。
 *
 * - 落盘格式为 JSONL，每行一个事件信封；
 * - 每条事件写入后 fsync，进程崩溃也不丢已确认的登记；
 * - 启动时逐行重放并校验哈希链，重建内存投影。
 */
export class EventLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.fh = null;
    this.seq = 0;
    this.headHash = null;
  }

  async start() {
    await mkdir(dirname(this.filePath), { recursive: true });
    let text = "";
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const events = [];
    let prevHash = null;
    text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        throw new LedgerTamperedError("事件账本第 " + (index + 1) + " 行不是合法 JSON", {
          line: index + 1,
        });
      }
      const expected = hashEvent(prevHash, {
        seq: event.seq,
        eventId: event.eventId,
        timestamp: event.timestamp,
        recordedAt: event.recordedAt,
        type: event.type,
        batchId: event.batchId ?? null,
        operator: event.operator ?? null,
        basis: event.basis ?? null,
        data: event.data,
      });
      if (event.hash !== expected) {
        throw new LedgerTamperedError(
          "事件账本第 " + (index + 1) + " 行哈希校验失败，链路不完整或被篡改",
          { line: index + 1, seq: event.seq, expected, actual: event.hash },
        );
      }
      if (event.prevHash !== prevHash) {
        throw new LedgerTamperedError(
          "事件账本第 " + (index + 1) + " 行前驱哈希不衔接",
          { line: index + 1, seq: event.seq },
        );
      }
      prevHash = event.hash;
      events.push(event);
    });

    this.seq = events.length ? events[events.length - 1].seq : 0;
    this.headHash = prevHash;
    this.fh = await open(this.filePath, "a");
    return events;
  }

  /**
   * 追加一条事件并落盘。调用方必须保证串行调用（见 HeritageService 的
   * 写入队列），seq 与 prevHash 才不会竞争。
   */
  async commit({ timestamp, recordedAt, type, batchId = null, operator = null, basis = null, data }) {
    const seq = this.seq + 1;
    const eventId = "evt-" + String(seq).padStart(10, "0");
    const fields = {
      seq,
      eventId,
      timestamp,
      recordedAt,
      type,
      batchId: batchId ?? null,
      operator: operator ?? null,
      basis: basis ?? null,
      data,
    };
    const hash = hashEvent(this.headHash, fields);
    const event = {
      version: LEDGER_VERSION,
      ...fields,
      prevHash: this.headHash,
      hash,
    };
    await this.fh.appendFile(JSON.stringify(event) + "\n");
    await this.fh.sync();
    this.seq = seq;
    this.headHash = hash;
    return event;
  }

  async close() {
    if (this.fh) await this.fh.close();
    this.fh = null;
  }
}
