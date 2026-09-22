# 馆藏登记与谱系追踪服务

面向市级博物馆藏品管理的后端：为器物建立**不可变身份**，把旧纸档、临时清单、
库房扫描中的多套编号归一到同一身份，记录来源与鉴定意见版本，支持合并/拆分登记，
保留每次更正的依据与经办人，并提供可核对的跨馆移交链路。

零第三方依赖，仅使用 Node.js 22 原生 HTTP、文件系统与 `node:test`。

## 核心特性

- **事件溯源 + 哈希链**：所有变更只追加到 `events.log`（JSONL，逐行 fsync），
  事件以 SHA-256 前后相扣；重启重放还原当前状态，篡改/截断日志会启动即报错。
- **不可变身份**：器物 ID（如 `artifact-0001`）一经生成永不变更；
  合并终止被并身份但继承其编号，拆分派生子件并保留父子谱系。
- **并发不重号**：写操作串行化，批次内并发录入同一编号只有一件成功，
  其余拿到结构化冲突原因；大小写/全半角/分隔符差异也有软冲突提示。
- **更正全程留痕**：基本信息、编号、鉴定意见的每次更正都记录字段、原因、依据、经办人；
  鉴定意见支持新版本取代、原版本挂更正、撤回三种历史形态。
- **撤销保护**：只有草稿可撤销；在借、在展、移交途中的操作一律被阻止并给出单据号。
- **跨馆移交链路**：发起→出库（取得事件哈希核对码）→凭码签收/拒收退回/取消，
  可导出含器物、事件与链头哈希的核对包。
- **可复核的审计**：按器物、批次、经办人、事件类型、时间范围检索，每条事件含 prevHash/hash。

## 运行

需要 Node.js ≥ 22。

```bash
npm ci
npm run seed          # 可选：写入样例批次（三套编号的青釉刻花瓷碗）
npm start             # 默认 :8000，数据目录可用 DATA_DIR 覆盖
npm test              # 32 项测试（服务级 + HTTP 端到端）
```

容器：`docker compose up --build`（事件日志持久化在 `heritage-data` 卷）。

关键环境变量：`PORT`（默认 8000）、`HOST`（默认 0.0.0.0）、
`DATA_DIR`（默认 `.runtime/data`）、`OWN_ORG`（本馆名称，默认"市博物馆"）。

## 快速体验

```bash
curl -X POST localhost:8000/v1/batches -H 'content-type: application/json' -d '{
  "actor":{"id":"u1","name":"王馆长","role":"管理员"},"note":"2026秋考古移交"}'
# 完整接口、权限矩阵与冲突原因见 docs/api.md
curl 'localhost:8000/v1/numbers/resolve?number=LS-20260912-07'
curl 'localhost:8000/v1/chain'
curl 'localhost:8000/v1/audit?batchId=batch-0001'
```

## 目录结构

```
src/
  domain/        领域层：事件投影（当前状态折叠）、编号标识、校验、错误
  store/         仅追加事件存储（JSONL + fsync + 哈希链校验）
  services/      HeritageService：事务边界、冲突检测、合并/拆分/移交业务规则
  http/          零依赖原生 HTTP 路由
  seed.js        样例数据
docs/api.md      API 与冲突原因手册
tests/           node:test 测试
```

设计约定见 `docs/domain.md`；时间字段统一 ISO 8601，身份字段为不可变字符串。
