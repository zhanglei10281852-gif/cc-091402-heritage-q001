// 业务错误：携带稳定错误码、HTTP 状态与结构化细节，
// 冲突原因（reasons）必须具体到编号/在借在展单据，供管理员复核。
export class DomainError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationFailed = (details) =>
  new DomainError("validation_error", 400, "请求数据未通过校验", { details });

export const unauthorized = (message = "缺少经办人信息") =>
  new DomainError("unauthorized", 401, message);

export const forbidden = (message, details = {}) =>
  new DomainError("forbidden", 403, message, details);

export const notFound = (resource, id) =>
  new DomainError("not_found", 404, `${resource}不存在：${id ?? ""}`.trim());

export const conflict = (message, reasons) =>
  new DomainError("conflict", 409, message, { reasons });

export const failedPrecondition = (message, details = {}) =>
  new DomainError("precondition_failed", 422, message, details);
