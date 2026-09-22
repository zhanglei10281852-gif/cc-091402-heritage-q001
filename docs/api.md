# 馆藏登记与谱系追踪 API

所有接口前缀 `/v1`，请求与响应均为 UTF-8 JSON，时间统一为带时区的 ISO 8601 字符串。

## 1. 设计模型

- **事件溯源**：一切写入都追加为一条不可变事件（`data/events.log`，每行一个 JSON）。
  当前状态不落盘，服务重启时重放全部事件得到；事件之间以 SHA-256 哈希前后相扣，
  任何篡改、缺行都会在启动校验时显式报错。
- **不可变身份**：器物一旦创建即获得 `artifact-0001` 形式的永久标识，不再变化；
  合并、拆分只会终止或派生身份，旧编号始终可解析。
- **编号两阶段**：草稿期编号为"待核验"（`numbers.pending`），登记后转为正式别名
  （`numbers.aliases`）。唯一约束覆盖待核验与正式两类占用。
- **经办人**：每个写接口都要带 `actor`；涉及更正/撤销/合并/拆分/估值的操作必须带 `basis`（依据）。

```jsonc
// actor
{ "id": "u-0001", "name": "王馆长", "role": "管理员" }
// role 取值：管理员 | 保护人员 | 只读访客
// basis（三选一至少给一个）
{ "document": "考古移交清册", "documentId": "KG-2026-017", "note": "第 12 页" }
```

经办人也可通过请求头传工号（头只支持 Latin-1，中文姓名/角色放请求体合并）：
`x-actor-id`、`x-actor-name`、`x-actor-role`。

## 2. 角色权限

| 操作 | 只读访客 | 保护人员 | 管理员 |
|---|---|---|---|
| 读取、编号解析、审计 | ✓ | ✓ | ✓ |
| 录入草稿、信息更正、库位/照片、鉴定意见 | ✗ | ✓ | ✓ |
| 登记、撤销草稿、合并、拆分、编号解除 | ✗ | ✗ | ✓ |
| 出借/展览、跨馆移交、保险估值 | ✗ | ✗ | ✓ |

## 3. 接口一览

### 批次
- `POST /v1/batches` 开立接收批次 `{actor, note?}`
- `GET  /v1/batches` 批次列表
- `GET  /v1/batches/:batchId` 批次详情（含器物及状态）
- `POST /v1/batches/:batchId/seal` 封存（批次内不得残留草稿）
- `GET  /v1/batches/:batchId/history` 批次事件历史

### 器物身份与编号
- `POST /v1/artifacts` 录入草稿 `{actor, batchId, info, excavation?, numbers[], allowDuplicates?}`
- `GET  /v1/artifacts?status=&batchId=&q=` 列表/检索（q 可填编号或名称）
- `GET  /v1/artifacts/:id` 器物当前视图（`:id` 可为器物 ID 或任一在用编号）
- `POST /v1/artifacts/:id/register` 核验登记（草稿 → 已登记）
- `POST /v1/artifacts/:id/void` 撤销草稿 `{actor, reason, basis}`
- `PATCH /v1/artifacts/:id` 信息更正 `{actor, reason, basis, info?, excavation?}`
- `POST /v1/artifacts/:id/numbers` 补编号（草稿→待核验；已登记→正式别名）`{actor, number, basis}`
- `POST /v1/artifacts/:id/numbers/unlink` 解除/移除编号 `{actor, number, reason, basis}`
- `PUT  /v1/artifacts/:id/appraisal` 保险估值 `{actor, appraisal{value,currency,insurer,policyNo?,note?}, basis}`
- `PUT  /v1/artifacts/:id/storage` 库位 `{actor, storage{location,shelfCode?,note?}}`
- `PUT  /v1/artifacts/:id/photos` 照片索引（全量替换）`{actor, photos[]}`
- `GET  /v1/artifacts/:id/history?from=&to=` 器物谱系与全部事件
- `GET  /v1/numbers/resolve?number=JD-1` 任意编号反查身份

编号对象：`{ "number": "JD-1987-0142", "namespace": "旧纸档", "source": "旧藏登记卡" }`，
`namespace` 取值：`旧纸档 | 临时清单 | 库房扫描 | 其他`。

### 鉴定意见（版本化）
- `POST /v1/artifacts/:id/authentications` 新增意见；不指定 `supersedes` 时自动取代当前版本
- `POST /v1/artifacts/:id/authentications/:authId/correct` 原版本上挂更正 `{actor, fields, reason, basis}`
- `POST /v1/artifacts/:id/authentications/:authId/retract` 撤回 `{actor, reason, basis}`

### 合并 / 拆分
- `POST /v1/artifacts/merge` `{actor, artifactIds[], survivorId, reason, basis}`
  被并身份置 `merged`，其正式编号全部由幸存身份继承；旧编号仍解析到幸存身份。
- `POST /v1/artifacts/:id/split` `{actor, reason, basis, children[{info, numbers[]}]}`
  父件置 `split`，系统自动开立承接批次，子件以草稿身份进入该批次等待登记。

### 出借 / 展览（撤销保护的占用来源）
- `POST /v1/artifacts/:id/loans` `{actor, borrower, loanNo, dueAt?}`
- `POST /v1/loans/:loanId/return` `{actor}`
- `POST /v1/artifacts/:id/exhibitions` `{actor, name, venue, exhibitionNo?}`
- `POST /v1/exhibitions/:exhibitionId/close` `{actor}`

在借或在展器物不能撤销编号、不能合并/拆分、不能移交，冲突响应会列出具体单据号。

### 跨馆移交（可核对链路）
- `POST /v1/transfers` `{actor, artifactIds[], fromOrg, toOrg, reason?, note?}`
- `POST /v1/transfers/:id/dispatch` 出库发运，返回 `verificationCode`（即出库事件 ID）
- `POST /v1/transfers/:id/accept` `{actor, verificationCode, note?}` 凭核对码签收
- `POST /v1/transfers/:id/reject` `{actor, reason, note?}` 拒收退回（状态恢复已登记）
- `POST /v1/transfers/:id/cancel` `{actor, reason}` 仅出库前可取消
- `GET  /v1/transfers/:id` 移交记录与时间线
- `GET  /v1/transfers/:id/package` 跨馆核对包：器物、相关事件、核对码、链头哈希

### 审计与哈希链
- `GET /v1/audit?type=&actorId=&batchId=&artifactId=&from=&to=&limit=` 审计事件
- `GET /v1/chain` 完整哈希链（创世块、链头、逐事件 prevHash/hash）
- `GET /health` 存活检查（返回当前链头哈希）

## 4. 冲突响应（HTTP 409）

`error.details.reasons[]` 中每条都给出可直接复核的结构化原因：

| type | 含义 | 关键字段 |
|---|---|---|
| `number_already_registered` | 编号已正式登记在他物名下 | `number` `heldBy` `heldNamespace` |
| `number_held_by_draft` | 编号被他物草稿占用待核验 | `heldBy` `heldBatch` |
| `number_similar_format` | 仅大小写/分隔符不同的疑似同号（软冲突） | `matchedNumber` |
| `possible_duplicate_artifact` | 名称+品类+出土地点完全相同 | `artifactId` |
| `artifact_on_loan` / `artifact_on_exhibition` | 在借 / 在展 | `loanId` `borrower` / `exhibitionId` |
| `artifact_in_transit` | 移交途中 | `transferId` |
| `verification_code_mismatch` | 移交核对码不符 | `expectedEventId` |

硬冲突（编号双占、在借在展）不可放行；软冲突（疑似同号、疑似重复器物）可由经办人
在请求中显式带 `"allowDuplicates": true` 放行，且放行了哪些冲突会原样写入事件。

## 5. 典型流程：三套编号归一

```bash
# 1) 开立批次
curl -X POST localhost:8000/v1/batches -d '{"actor":A,"note":"2026秋考古移交"}'
# 2) 录入草稿（三个来源编号一并提交）
curl -X POST localhost:8000/v1/artifacts -d '{
  "actor":A,"batchId":"batch-0001",
  "info":{"name":"青釉刻花瓷碗","category":"瓷器","dynasty":"北宋"},
  "excavation":{"site":"龙泉窑遗址","location":"Y3 北侧 H12"},
  "numbers":[
    {"number":"JD-1987-0142","namespace":"旧纸档"},
    {"number":"LS-20260912-07","namespace":"临时清单"},
    {"number":"SCAN-KF-A3-0207","namespace":"库房扫描"}]}'
# 3) 补鉴定意见、库位、照片后核验登记
curl -X POST localhost:8000/v1/artifacts/artifact-0001/register -d '{"actor":A}'
# 此后三个编号都解析到 artifact-0001；展签与保险估值以该身份为准
curl 'localhost:8000/v1/numbers/resolve?number=LS-20260912-07'
```
