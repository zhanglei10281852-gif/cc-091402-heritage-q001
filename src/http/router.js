import { createServer } from "node:http";
import { DomainError } from "../domain/errors.js";

// 极简路由：零依赖原生 http。service 缺省时仅提供健康检查（兼容基础工程测试）。
export function createApp(service = null) {
  const routes = service ? buildRoutes(service) : [];

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        // 不传 service 时保持基础工程的健康响应契约不变。
        if (!service) {
          return sendJson(response, 200, {
            status: "ok",
            service: "heritage-service-starter",
          });
        }
        return sendJson(response, 200, {
          status: "ok",
          service: "heritage-registry",
          headHash: service.headHash(),
        });
      }
      if (!service) return notFound(response);

      const url = new URL(request.url, "http://local");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const match = matchRoute(routes, request.method, path);
      if (!match) return notFound(response);

      const body = await readBody(request);
      const headerActor = actorFromHeaders(request.headers);
      // 请求头只能携带 Latin-1 字符（通常放工号）；请求体可补充中文姓名与角色，两者合并。
      if (headerActor) body.actor = { ...headerActor, ...(body.actor ?? {}) };

      const result = await match.handler({
        params: match.params,
        query: url.searchParams,
        body,
      });
      // service 方法直接返回业务对象；显式 { status, body } 也兼容。
      const out = result && Object.hasOwn(result, "body") ? result : { status: 200, body: result };
      return sendJson(response, out.status ?? 200, out.body);
    } catch (error) {
      return handleError(response, error);
    }
  });
}

function buildRoutes(service) {
  const r = (method, pattern, handler) => ({
    method,
    segments: pattern.split("/").filter(Boolean),
    handler,
  });
  const ok = (body) => ({ status: 200, body });

  return [
    // 批次
    r("POST", "/v1/batches", ({ body }) => service.openBatch(body)),
    r("GET", "/v1/batches", () => ok(service.listBatches())),
    r("GET", "/v1/batches/:batchId", ({ params }) => ok(service.getBatch(params.batchId))),
    r("POST", "/v1/batches/:batchId/seal", ({ params, body }) =>
      service.sealBatch(params.batchId, body)),
    r("GET", "/v1/batches/:batchId/history", ({ params }) =>
      ok(service.historyOfBatch(params.batchId))),

    // 器物
    r("POST", "/v1/artifacts", ({ body }) => service.createArtifact(body)),
    r("GET", "/v1/artifacts", ({ query }) =>
      ok(
        service.listArtifacts({
          status: query.get("status") || undefined,
          batchId: query.get("batchId") || undefined,
          q: query.get("q") || undefined,
        }),
      )),
    r("POST", "/v1/artifacts/merge", ({ body }) => service.mergeArtifacts(body)),
    r("GET", "/v1/artifacts/:id", ({ params }) => ok(service.getArtifactView(params.id))),
    r("POST", "/v1/artifacts/:id/register", ({ params, body }) =>
      service.registerArtifact(params.id, body)),
    r("POST", "/v1/artifacts/:id/void", ({ params, body }) => service.voidDraft(params.id, body)),
    r("PATCH", "/v1/artifacts/:id", ({ params, body }) => service.correctInfo(params.id, body)),
    r("POST", "/v1/artifacts/:id/numbers", ({ params, body }) =>
      service.linkNumber(params.id, body)),
    r("POST", "/v1/artifacts/:id/numbers/unlink", ({ params, body }) =>
      service.unlinkNumber(params.id, body)),
    r("PUT", "/v1/artifacts/:id/appraisal", ({ params, body }) =>
      service.updateAppraisal(params.id, body)),
    r("PUT", "/v1/artifacts/:id/storage", ({ params, body }) =>
      service.updateStorage(params.id, body)),
    r("PUT", "/v1/artifacts/:id/photos", ({ params, body }) =>
      service.updatePhotos(params.id, body)),
    r("POST", "/v1/artifacts/:id/split", ({ params, body }) =>
      service.splitArtifact(params.id, body)),
    r("GET", "/v1/artifacts/:id/history", ({ params, query }) =>
      ok(
        service.historyOfArtifact(params.id, {
          from: query.get("from") || undefined,
          to: query.get("to") || undefined,
        }),
      )),

    // 鉴定意见版本
    r("POST", "/v1/artifacts/:id/authentications", ({ params, body }) =>
      service.addAuthentication(params.id, body)),
    r("POST", "/v1/artifacts/:id/authentications/:authId/correct", ({ params, body }) =>
      service.correctAuthentication(params.id, params.authId, body)),
    r("POST", "/v1/artifacts/:id/authentications/:authId/retract", ({ params, body }) =>
      service.retractAuthentication(params.id, params.authId, body)),

    // 出借 / 展览
    r("POST", "/v1/artifacts/:id/loans", ({ params, body }) => service.openLoan(params.id, body)),
    r("POST", "/v1/artifacts/:id/exhibitions", ({ params, body }) =>
      service.openExhibition(params.id, body)),
    r("POST", "/v1/loans/:loanId/return", ({ params, body }) =>
      service.returnLoan(params.loanId, body)),
    r("POST", "/v1/exhibitions/:exhibitionId/close", ({ params, body }) =>
      service.closeExhibition(params.exhibitionId, body)),

    // 跨馆移交
    r("POST", "/v1/transfers", ({ body }) => service.createTransfer(body)),
    r("GET", "/v1/transfers/:transferId", ({ params }) =>
      ok(service.getTransferView(params.transferId))),
    r("GET", "/v1/transfers/:transferId/package", ({ params }) =>
      ok(service.transferPackage(params.transferId))),
    r("POST", "/v1/transfers/:transferId/dispatch", ({ params, body }) =>
      service.dispatchTransfer(params.transferId, body)),
    r("POST", "/v1/transfers/:transferId/accept", ({ params, body }) =>
      service.acceptTransfer(params.transferId, body)),
    r("POST", "/v1/transfers/:transferId/reject", ({ params, body }) =>
      service.rejectTransfer(params.transferId, body)),
    r("POST", "/v1/transfers/:transferId/cancel", ({ params, body }) =>
      service.cancelTransfer(params.transferId, body)),

    // 编号解析 / 审计 / 哈希链
    r("GET", "/v1/numbers/resolve", ({ query }) =>
      ok(service.resolveNumber(query.get("number") ?? ""))),
    r("GET", "/v1/audit", ({ query }) =>
      ok(
        service.audit({
          type: query.get("type") || undefined,
          actorId: query.get("actorId") || undefined,
          batchId: query.get("batchId") || undefined,
          artifactId: query.get("artifactId") || undefined,
          from: query.get("from") || undefined,
          to: query.get("to") || undefined,
          limit: query.get("limit") || undefined,
        }),
      )),
    r("GET", "/v1/chain", () => ok(service.store.proof())),
  ];
}

function matchRoute(routes, method, path) {
  const segments = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < segments.length; i++) {
      const patternSegment = route.segments[i];
      if (patternSegment.startsWith(":")) {
        params[patternSegment.slice(1)] = decodeURIComponent(segments[i]);
      } else if (patternSegment !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: route.handler, params };
  }
  return null;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DomainError("validation_error", 400, "请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new DomainError("validation_error", 400, "请求体不是合法 JSON", {
        details: [{ field: "body", issue: cause.message }],
      });
    }
    throw cause;
  }
}

function actorFromHeaders(headers) {
  const id = headers["x-actor-id"];
  const name = headers["x-actor-name"];
  if (!id && !name) return null;
  return {
    id: id ? String(id) : undefined,
    name: name ? String(name) : undefined,
    role: headers["x-actor-role"] ? String(headers["x-actor-role"]) : undefined,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  sendJson(response, 404, { error: { code: "not_found", message: "接口不存在" } });
}

function handleError(response, error) {
  if (error instanceof DomainError) {
    return sendJson(response, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  console.error(error);
  sendJson(response, 500, {
    error: { code: "internal_error", message: "服务内部错误，请查看服务日志" },
  });
}
