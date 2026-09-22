import { ApiError, HeritageService } from "../domain/heritage-service.js";

// 轻量路由：零依赖，按"方法 + 路径模式"匹配，:param 段以冒号标注。
function matchRoute(routes, method, pathname) {
  const asked = pathname.split("/").filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== asked.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < asked.length; i++) {
      const expected = candidate.segments[i];
      if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(asked[i]);
      else if (expected !== asked[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: candidate.handler, params };
  }
  return null;
}

async function readJson(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const limit = 2 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过 2MB 上限");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

function errorBody(error) {
  return {
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function createRouter(service) {
  const routes = [];
  const route = (method, pattern, handler) => {
    routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
  };

  // ---- 器物登记 ----
  route("POST", "/v1/artifacts", (ctx) => service.registerArtifact(ctx.body));
  route("GET", "/v1/artifacts", (ctx) => ({
    artifacts: service.listArtifacts({
      status: ctx.query.status,
      custody: ctx.query.custody,
      batchId: ctx.query.batchId,
      q: ctx.query.q,
    }),
  }));
  // 多器物裁定的静态路径优先于 :id 形态。
  route("POST", "/v1/artifacts/merge", (ctx) => service.mergeArtifacts(ctx.body));
  route("GET", "/v1/artifacts/:id", (ctx) => service.getArtifact(ctx.params.id));
  route("POST", "/v1/artifacts/:id/confirm", (ctx) => service.confirmArtifact(ctx.params.id, ctx.body));
  route("POST", "/v1/artifacts/:id/withdraw", (ctx) => service.withdrawArtifact(ctx.params.id, ctx.body));
  route("POST", "/v1/artifacts/:id/splits", (ctx) => service.splitArtifact(ctx.params.id, ctx.body));
  route("PATCH", "/v1/artifacts/:id/corrections", (ctx) => service.correctInformation(ctx.params.id, ctx.body));
  route("GET", "/v1/artifacts/:id/history", (ctx) => service.getArtifactHistory(ctx.params.id));
  route("GET", "/v1/artifacts/:id/lineage", (ctx) => service.getLineage(ctx.params.id));

  // ---- 编号 ----
  route("POST", "/v1/artifacts/:id/identifiers", (ctx) => service.addIdentifier(ctx.params.id, ctx.body));
  route("POST", "/v1/artifacts/:id/identifiers/void", (ctx) => service.voidIdentifier(ctx.params.id, ctx.body));
  route("GET", "/v1/identifiers/resolve", (ctx) => service.resolveIdentifier(ctx.query.value ?? ""));

  // ---- 鉴定版本 ----
  route("POST", "/v1/artifacts/:id/appraisals", (ctx) => service.addAppraisal(ctx.params.id, ctx.body));
  route("POST", "/v1/artifacts/:id/appraisals/:appraisalId/retract", (ctx) =>
    service.retractAppraisal(ctx.params.id, ctx.params.appraisalId, ctx.body),
  );

  // ---- 库位 ----
  route("POST", "/v1/artifacts/:id/location-moves", (ctx) => service.moveLocation(ctx.params.id, ctx.body));

  // ---- 出借 / 展览占用 ----
  route("POST", "/v1/artifacts/:id/usages", (ctx) => service.recordUsage(ctx.params.id, ctx.body));
  route("POST", "/v1/artifacts/:id/usages/:usageId/complete", (ctx) =>
    service.completeUsage(ctx.params.id, ctx.params.usageId, ctx.body),
  );

  // ---- 批次 ----
  route("GET", "/v1/batches", () => ({ batches: service.listBatches() }));
  route("GET", "/v1/batches/:id", (ctx) => service.getBatch(ctx.params.id));

  // ---- 跨馆移交 ----
  route("POST", "/v1/transfers/outbound", (ctx) => service.initiateTransferOut(ctx.body));
  route("POST", "/v1/transfers/inbound", (ctx) => service.recordInboundTransfer(ctx.body));
  route("GET", "/v1/transfers", () => ({ transfers: service.listTransfers() }));
  route("GET", "/v1/transfers/:id", (ctx) => service.getTransfer(ctx.params.id));
  route("POST", "/v1/transfers/:id/confirm", (ctx) => service.confirmTransferOut(ctx.params.id, ctx.body));
  route("POST", "/v1/transfers/:id/verify-manifest", (ctx) =>
    service.verifyInboundManifest(ctx.params.id, ctx.body.fingerprint ?? ""),
  );

  // ---- 审计与账本 ----
  route("GET", "/v1/audit/events", (ctx) =>
    service.queryAuditEvents({
      type: ctx.query.type,
      batchId: ctx.query.batchId,
      artifactId: ctx.query.artifactId,
      from: ctx.query.from,
      to: ctx.query.to,
      afterSeq: ctx.query.afterSeq,
      limit: ctx.query.limit,
    }),
  );
  route("GET", "/v1/ledger/status", () => service.chainStatus());

  return async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
    };
    try {
      const matched = matchRoute(routes, request.method, url.pathname);
      if (!matched) {
        send(404, { error: { code: "NOT_FOUND", message: "没有对应的接口：" + request.method + " " + url.pathname } });
        return;
      }
      const body = await readJson(request);
      const query = Object.fromEntries(url.searchParams);
      const result = await matched.handler({ body, query, params: matched.params });
      send(200, { data: result });
    } catch (error) {
      if (error instanceof ApiError) {
        send(error.status, errorBody(error));
        return;
      }
      console.error("未处理错误：", error);
      send(500, { error: { code: "INTERNAL_ERROR", message: "服务内部错误" } });
    }
  };
}

export { HeritageService };
