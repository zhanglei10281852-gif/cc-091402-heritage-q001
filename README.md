# 馆藏登记与谱系追踪服务

面向市级博物馆藏品管理的后端：为器物建立**不可变身份**，记录来源、出土地点、照片索引与鉴定版本，
处理重复登记的合并与套器拆分，保留每一次更正的**依据与经办人**，并让跨馆移交形成可核对的链路。

零第三方依赖，仅使用 Node.js 22 内置模块。

## 为什么用事件账本

所有业务裁定（登记、确认、编号作废、更正、鉴定、合并、拆分、移交、撤销……）都是一条
**只追加（append-only）事件**，写入 `.data/heritage-ledger.jsonl`（可由 `DATA_FILE` 配置）：

- 每条事件含 `seq`、`eventId`、业务发生时间 `timestamp`、入库时间 `recordedAt`、批次、
  经办人 `operator`、依据 `basis`、业务数据 `data`；
- 每条事件的哈希覆盖其全部字段与上一条事件哈希（SHA-256，规范化序列化），形成**逐条咬合的哈希链**；
- 写入即 `fsync`。服务重启时逐行重放并校验全链：任何一行被增删改，启动立即中止并报 `LEDGER_TAMPERED`；
- 当前状态（器物、编号索引、批次、移交单）全部由事件重放得到，可按器物、批次、时间窗还原全部历史。

## 运行

```bash
npm ci
npm start            # 默认 0.0.0.0:8000，账本在 .data/heritage-ledger.jsonl
npm test             # 26 个内置测试
docker compose up --build
```

环境变量：`PORT`、`HOST`、`DATA_FILE`、`INSTITUTION_CODE`（默认 MUS）、`INSTITUTION_NAME`（默认 市级博物馆）。

## 核心规则

- **并发不产生重复身份**：所有写操作在服务内串行排队；编号以 trim+大写归一化后建唯一索引，
  冲突返回 409 并指明已占用的身份。客户端可带 `clientRequestId` 做请求级幂等（重试返回既有身份）。
- **撤销只影响草稿**：仅 `draft` 可撤销，且一旦该草稿曾被出借/展览引用即拒绝（409 `ARTIFACT_IN_USE`），
  返回占用单号；正式登记的更正必须走更正事件，旧值与依据永不被覆盖。
- **合并/拆分**：只允许已确认、在馆、无未结束占用的身份。合并保留被并方全部编号与鉴定意见（标注来源）；
  拆分的子身份先整批校验编号冲突，再以单个事件原子生效。
- **跨馆移交**：出库生成随件清单的 SHA-256 指纹（在途→交讫），入库登记对方指纹并可随时核对；
  入库清单任一条编号与本馆冲突则整批拒绝。

## 接口一览（前缀 `/v1`，响应统一为 `{ "data": ... }`，错误为 `{ "error": { code, message, details } }`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/artifacts` | 登记器物（返回不可变身份 `artifact-xxxx`，初始为草稿） |
| GET | `/artifacts` | 列表，可按 `status/custody/batchId/q` 过滤 |
| GET | `/artifacts/:id` | 器物当前完整状态（编号、鉴定版本、库位轨迹、谱系、来源） |
| POST | `/artifacts/:id/confirm` | 草稿复核确认 |
| POST | `/artifacts/:id/withdraw` | 撤销草稿（受限，见上） |
| PATCH | `/artifacts/:id/corrections` | 更正基本信息/出土地点/照片索引（必须带 basis） |
| POST | `/artifacts/:id/identifiers` | 补挂来源编号（旧纸档/临时清单/库房扫描等） |
| POST | `/artifacts/:id/identifiers/void` | 作废编号（保留痕迹，失效编号仍可解析出去向） |
| GET | `/identifiers/resolve?value=` | 用任意编号反查当前可信身份 |
| POST | `/artifacts/:id/appraisals` | 追加鉴定版本（版本号不复用，可撤回留痕） |
| POST | `/artifacts/:id/appraisals/:apr/retract` | 撤回鉴定版本 |
| POST | `/artifacts/:id/location-moves` | 库位移动 |
| POST | `/artifacts/:id/usages` | 登记出借（loan）/展览（exhibition）占用 |
| POST | `/artifacts/:id/usages/:uid/complete` | 结束占用 |
| POST | `/artifacts/merge` | 合并重复身份（survivorId + sourceIds） |
| POST | `/artifacts/:id/splits` | 拆分为多个独立身份 |
| GET | `/artifacts/:id/history` | 该器物全部事件（含每条哈希，可逐节复核） |
| GET | `/artifacts/:id/lineage` | 合并/拆分谱系图（节点 + 边） |
| GET | `/batches` `/batches/:id` | 批次视图 |
| POST | `/transfers/outbound` | 发起出库移交，返回清单指纹 |
| POST | `/transfers/:id/confirm` | 凭对方签收凭据确认交讫 |
| POST | `/transfers/inbound` | 跨馆入库整批建档（可带对方清单指纹） |
| POST | `/transfers/:id/verify-manifest` | 核对入库指纹是否一致 |
| GET | `/transfers` `/transfers/:id` | 移交单查询 |
| GET | `/audit/events` | 审计事件，可按 `type/batchId/artifactId/from/to/afterSeq/limit` 过滤 |
| GET | `/ledger/status` | 链头序号与哈希（可与外部留底比对） |

每个写请求都应携带：

```json
{
  "operator": { "id": "u-001", "name": "李馆员", "role": "管理员" },
  "basis": { "type": "考古移交单", "summary": "三源编号与实物一致", "documentRef": "DOC-0922" }
}
```

## 典型冲突响应（管理员据此复核）

```json
{
  "error": {
    "code": "IDENTIFIER_CONFLICT",
    "message": "编号与已有不可变身份冲突，登记被拒绝",
    "details": {
      "conflicts": [{
        "value": "JIU-001",
        "system": "paper-legacy",
        "ownerArtifactId": "artifact-0001",
        "ownerIdentifierSystem": "paper-legacy",
        "reason": "该编号已绑定不可变身份 artifact-0001"
      }],
      "hint": "如确认为同一器物，请使用合并接口；如为旧档误植，请先作废该编号。"
    }
  }
}
```
