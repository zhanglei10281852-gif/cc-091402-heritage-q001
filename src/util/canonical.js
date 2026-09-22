import { createHash } from "node:crypto";

// 规范化 JSON：键排序，剔除 undefined，保证同一事件在任何进程中哈希一致。
export function canonical(value) {
  return JSON.stringify(sort(value));
}

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, sort(value[key])]),
    );
  }
  return value;
}

// 事件链式哈希：后一事件携带前一事件的哈希，任何篡改都会在重启校验/审计核验时暴露。
export function hashEvent(prevHash, eventBody) {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonical(eventBody))
    .digest("hex");
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
