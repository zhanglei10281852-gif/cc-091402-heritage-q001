import { validationFailed } from "./errors.js";

const NAMESPACES = ["旧纸档", "临时清单", "库房扫描", "其他"];
const ROLES = ["管理员", "保护人员", "只读访客"];
const CONFIDENCE = ["高", "中", "低", "存疑"];

class Checker {
  constructor() {
    this.errors = [];
  }

  require(value, field, label) {
    if (value === undefined || value === null || value === "") {
      this.errors.push({ field, issue: `${label}不能为空` });
      return false;
    }
    return true;
  }

  string(value, field, label, { max = 2000 } = {}) {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") {
      this.errors.push({ field, issue: `${label}必须是字符串` });
      return;
    }
    if (value.trim() === "") this.errors.push({ field, issue: `${label}不能为空` });
    if (value.length > max) this.errors.push({ field, issue: `${label}长度不能超过 ${max}` });
  }

  enum(value, field, label, allowed) {
    if (value === undefined || value === null) return;
    if (!allowed.includes(value)) {
      this.errors.push({ field, issue: `${label}必须是：${allowed.join("、")}` });
    }
  }

  array(value, field, label) {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) this.errors.push({ field, issue: `${label}必须是数组` });
  }

  object(value, field, label) {
    if (value === undefined || value === null) {
      this.errors.push({ field, issue: `${label}不能为空` });
      return false;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      this.errors.push({ field, issue: `${label}必须是对象` });
      return false;
    }
    return true;
  }

  done() {
    if (this.errors.length) {
      const seen = new Set();
      const details = this.errors.filter((entry) => {
        const key = `${entry.field}|${entry.issue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      throw validationFailed(details);
    }
  }
}

function checkActor(c, actor, path = "actor") {
  if (!c.object(actor, path, "经办人")) return;
  c.require(actor.id, `${path}.id`, "经办人标识");
  c.string(actor.id, `${path}.id`, "经办人标识", { max: 100 });
  c.require(actor.name, `${path}.name`, "经办人姓名");
  c.string(actor.name, `${path}.name`, "经办人姓名", { max: 100 });
  c.enum(actor.role, `${path}.role`, "经办角色", ROLES);
}

function checkBasis(c, basis, path = "basis", { required = true } = {}) {
  if (basis === undefined || basis === null) {
    if (required) c.errors.push({ field: path, issue: "必须提供更正/操作依据" });
    return;
  }
  if (!c.object(basis, path, "依据")) return;
  c.string(basis.document, `${path}.document`, "依据文件", { max: 500 });
  c.string(basis.documentId, `${path}.documentId`, "依据文件编号", { max: 200 });
  c.string(basis.note, `${path}.note`, "依据说明", { max: 2000 });
  if (required && !basis.document && !basis.documentId && !basis.note) {
    c.errors.push({ field: path, issue: "依据至少包含文件、文件编号或说明之一" });
  }
}

function checkNumber(c, entry, path) {
  if (!c.object(entry, path, "编号")) return;
  c.require(entry.number, `${path}.number`, "编号值");
  c.string(entry.number, `${path}.number`, "编号值", { max: 100 });
  c.require(entry.namespace, `${path}.namespace`, "编号来源系统");
  c.enum(entry.namespace, `${path}.namespace`, "编号来源系统", NAMESPACES);
  c.string(entry.source, `${path}.source`, "编号来源说明", { max: 500 });
}

function checkInfo(c, info, path, { partial = false } = {}) {
  if (info === undefined || info === null) {
    if (!partial) c.errors.push({ field: path, issue: "器物基本信息不能为空" });
    return;
  }
  if (!c.object(info, path, "器物基本信息")) return;
  if (!partial) c.require(info.name, `${path}.name`, "器物名称");
  c.string(info.name, `${path}.name`, "器物名称", { max: 200 });
  c.string(info.category, `${path}.category`, "品类", { max: 100 });
  c.string(info.dynasty, `${path}.dynasty`, "年代", { max: 100 });
  c.string(info.material, `${path}.material`, "材质", { max: 200 });
  c.string(info.dimensions, `${path}.dimensions`, "尺寸", { max: 200 });
  c.string(info.description, `${path}.description`, "描述", { max: 5000 });
}

function checkExcavation(c, excavation, path) {
  if (excavation === undefined || excavation === null) return;
  if (!c.object(excavation, path, "出土地点")) return;
  c.string(excavation.site, `${path}.site`, "出土遗址/地点", { max: 300 });
  c.string(excavation.location, `${path}.location`, "具体位置", { max: 300 });
  c.string(excavation.date, `${path}.date`, "出土日期", { max: 100 });
  c.string(excavation.method, `${path}.method`, "发掘方式", { max: 300 });
}

function checkPhotos(c, photos, path) {
  if (photos === undefined || photos === null) return;
  c.array(photos, path, "照片索引");
  if (!Array.isArray(photos)) return;
  photos.forEach((photo, index) => {
    const p = `${path}[${index}]`;
    if (!c.object(photo, p, "照片")) return;
    c.require(photo.photoId, `${p}.photoId`, "照片标识");
    c.string(photo.photoId, `${p}.photoId`, "照片标识", { max: 200 });
    c.string(photo.uri, `${p}.uri`, "照片地址/索引", { max: 1000 });
    c.string(photo.caption, `${p}.caption`, "照片说明", { max: 500 });
  });
  const ids = photos.map((p) => p.photoId).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    c.errors.push({ field: path, issue: "照片标识不能重复" });
  }
}

function checkNumbers(c, numbers, path, { requireOne = true } = {}) {
  if (numbers === undefined || numbers === null) {
    if (requireOne) c.errors.push({ field: path, issue: "至少提供一个待核验编号" });
    return;
  }
  c.array(numbers, path, "编号列表");
  if (!Array.isArray(numbers)) return;
  if (requireOne && numbers.length === 0) {
    c.errors.push({ field: path, issue: "至少提供一个待核验编号" });
  }
  numbers.forEach((entry, index) => checkNumber(c, entry, `${path}[${index}]`));
  const values = numbers.map((n) => n?.number).filter(Boolean);
  if (new Set(values).size !== values.length) {
    c.errors.push({ field: path, issue: "同一请求中的编号不能重复" });
  }
}

export const validators = {
  actor: checkActor,
  basis: checkBasis,
  number: checkNumber,
  info: checkInfo,
  excavation: checkExcavation,
  photos: checkPhotos,
  numbers: checkNumbers,
};

export { Checker, NAMESPACES, ROLES, CONFIDENCE };

export function validate(body, shape) {
  const c = new Checker();
  shape(c, body ?? {});
  c.done();
}
