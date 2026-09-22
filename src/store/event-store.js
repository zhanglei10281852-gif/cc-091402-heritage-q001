import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { hashEvent } from "../util/canonical.js";

const GENESIS = "0".repeat(64);
const LOG_FILE = "events.log";
const TMP_SUFFIX = ".tmp";

// 仅包含在哈希链中的事件字段（信封字段 hash/prevHash 自身不参与）。
function chainBody(event) {
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    actor: event.actor,
    batchId: event.batchId,
    data: event.data,
  };
}

// 仅追加事件存储：每行一个 JSON 事件，事件按哈希前后相扣。
// 重启时全量重放日志并逐事件校验哈希链，任何篡改/缺行都会显式暴露。
export class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.logPath = join(dataDir, LOG_FILE);
    this.events = [];
    this.tailHash = GENESIS;
  }

  load() {
    mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.logPath)) {
      this.events = [];
      this.tailHash = GENESIS;
      return { eventCount: 0, verified: true };
    }
    const lines = readFileSync(this.logPath, "utf8").split("\n");
    const events = [];
    let prev = GENESIS;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (cause) {
        throw new Error(
          `事件日志第 ${index + 1} 行不是合法 JSON，存储可能已损坏`,
          { cause },
        );
      }
      const expected = hashEvent(prev, chainBody(event));
      if (event.prevHash !== prev || event.hash !== expected) {
        throw new Error(
          `事件日志哈希链在第 ${index + 1} 行（事件 ${event.id}）断裂：` +
            "日志被篡改、截断或来自不同的谱系分支",
        );
      }
      prev = event.hash;
      events.push(event);
    }
    this.events = events;
    this.tailHash = prev;
    return { eventCount: events.length, verified: true };
  }

  // 追加必须在服务层的串行锁内调用：业务校验与追加共同构成原子事务。
  append(body) {
    const event = { ...body, prevHash: this.tailHash };
    event.hash = hashEvent(this.tailHash, chainBody(event));
    const line = JSON.stringify(event) + "\n";
    // a 标志 + fsync：崩溃时要么整行落盘，要么不存在，不会读到半行。
    const fd = openSync(this.logPath, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.events.push(event);
    this.tailHash = event.hash;
    return event;
  }

  all() {
    return this.events;
  }

  headHash() {
    return this.tailHash;
  }

  size() {
    return this.events.length;
  }

  // 运维/跨馆核对用：导出从创世块开始的完整哈希链证据。
  proof() {
    return {
      genesis: GENESIS,
      head: this.tailHash,
      eventCount: this.events.length,
      chain: this.events.map((event) => ({
        id: event.id,
        type: event.type,
        prevHash: event.prevHash,
        hash: event.hash,
      })),
    };
  }

  // 归档：将当前日志原子替换为外部已核对的日志（仅用于跨馆恢复，运行时不开放）。
  static replaceLog(dataDir, serializedEvents) {
    mkdirSync(dataDir, { recursive: true });
    const target = join(dataDir, LOG_FILE);
    const tmp = target + TMP_SUFFIX;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, serializedEvents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }
}

export { GENESIS };
