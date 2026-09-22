import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { HeritageService } from "./services/heritage-service.js";

// 样例数据：覆盖器物基本信息、出土地点、照片索引、鉴定意见、库位与保险估值，
// 以及"旧纸档/临时清单/库房扫描"三套编号指向同一器物的核心场景。
// 用法：npm run seed（数据写入 DATA_DIR 或 .runtime/seed-data）
const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), ".runtime/seed-data");
mkdirSync(dataDir, { recursive: true });

const svc = new HeritageService({ dataDir, ownOrg: process.env.OWN_ORG ?? "市博物馆" });
const info = svc.start();
if (info.eventCount > 0) {
  console.log(`数据目录 ${dataDir} 已有 ${info.eventCount} 条事件，跳过种子。`);
  process.exit(0);
}

const admin = { id: "u-0001", name: "王馆长", role: "管理员" };
const curator = { id: "u-0002", name: "李保护", role: "保护人员" };

const { batch } = await svc.openBatch({
  actor: admin,
  note: "2026 年 9 月龙泉窑遗址考古移交（样例批次）",
});

const { artifact } = await svc.createArtifact({
  actor: admin,
  batchId: batch.id,
  info: {
    name: "青釉刻花瓷碗",
    category: "瓷器",
    dynasty: "北宋",
    material: "瓷胎，青釉",
    dimensions: "口径 18.2 cm，高 7.1 cm，底径 5.8 cm",
    description: "敞口斜弧腹，圈足；内壁刻折枝花卉，外壁刻仰莲瓣，釉色青润。",
  },
  excavation: {
    site: "龙泉窑遗址",
    location: "三号窑炉 Y3 北侧灰坑 H12",
    date: "2026-09-08",
    method: "抢救性考古发掘",
  },
  numbers: [
    { number: "JD-1987-0142", namespace: "旧纸档", source: "1987 年旧藏登记卡" },
    { number: "LS-20260912-07", namespace: "临时清单", source: "本次考古移交临时清单第 7 行" },
    { number: "SCAN-KF-A3-0207", namespace: "库房扫描", source: "入库扫描枪批次 A3" },
  ],
});
const id = artifact.id;

await svc.updateStorage(id, {
  actor: curator,
  storage: { location: "一号库房 瓷器区", shelfCode: "C-A12-03", note: "锦盒单独存放，避光" },
});
await svc.updatePhotos(id, {
  actor: curator,
  photos: [
    { photoId: "P-2026-0001", uri: "photos/2026/09/P-2026-0001.jpg", caption: "正面全貌" },
    { photoId: "P-2026-0002", uri: "photos/2026/09/P-2026-0002.jpg", caption: "底部圈足" },
    { photoId: "P-2026-0003", uri: "photos/2026/09/P-2026-0003.jpg", caption: "内壁刻花特写" },
  ],
});
await svc.addAuthentication(id, {
  actor: curator,
  authentication: {
    authenticator: "张素胎",
    organization: "省文物鉴定站",
    opinion: "器形、刻花与釉色均符合北宋龙泉窑特征，判定为真品。",
    confidence: "高",
    attaches: ["鉴定书 JDS-2026-031 扫描件"],
    basis: { document: "鉴定书", documentId: "JDS-2026-031" },
  },
});
await svc.registerArtifact(id, { actor: admin });
await svc.updateAppraisal(id, {
  actor: admin,
  appraisal: {
    value: 800000,
    currency: "CNY",
    insurer: "中国人民财产保险股份有限公司",
    policyNo: "BX-2026-MUSEUM-044",
    note: "按一级品征展保险口径估值",
  },
  basis: { document: "艺术品估值报告", documentId: "GZ-2026-044" },
});

const { batch: second } = await svc.openBatch({ actor: admin, note: "比对件批次（样例）" });
await svc.createArtifact({
  actor: curator,
  batchId: second.id,
  info: {
    name: "青釉刻花瓷碗（征集比对件）",
    category: "瓷器",
    dynasty: "待考",
    material: "瓷胎，青釉",
  },
  excavation: { site: "传世品征集", location: null, date: "2026-09-15", method: "社会征集" },
  numbers: [{ number: "ZJ-2026-003", namespace: "临时清单", source: "征集临牌号" }],
});

console.log(
  JSON.stringify(
    {
      message: "样例数据已写入",
      dataDir,
      batchId: batch.id,
      artifactId: id,
      headHash: svc.headHash(),
      hint: `curl 'http://127.0.0.1:8000/v1/numbers/resolve?number=LS-20260912-07'`,
    },
    null,
    2,
  ),
);
