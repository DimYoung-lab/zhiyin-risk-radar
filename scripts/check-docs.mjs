import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const packageRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const docRoot = packageRoot ?? root;
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
const docs = [
  path.join(docRoot, "README.md"),
  ...walk(path.join(docRoot, "docs")).filter((f) => f.endsWith(".md")),
];
if (packageRoot) docs.push(path.join(packageRoot, "00_提交说明.md"));
const failures = [];
let links = 0,
  packageReferences = 0;
for (const doc of docs) {
  const content = fs.readFileSync(doc, "utf8");
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split(/\s+"/)[0];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    ++links;
    const file = decodeURIComponent(target.split("#")[0]);
    if (!fs.existsSync(path.resolve(path.dirname(doc), file)))
      failures.push(`${path.relative(docRoot, doc)} → ${target}`);
  }
  if (packageRoot) {
    for (const match of content.matchAll(
      /`(verification\/[\w.-]+\.json|演示视频\.mp4|delivery-manifest\.json)`/g,
    )) {
      ++packageReferences;
      if (!fs.existsSync(path.join(packageRoot, match[1])))
        failures.push(`${path.relative(docRoot, doc)} → package:${match[1]}`);
    }
  }
}
if (packageRoot) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "delivery-manifest.json"), "utf8"),
  );
  const unit = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/unit-test-report.json"),
      "utf8",
    ),
  );
  const api = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/integration-report.json"),
      "utf8",
    ),
  );
  if (
    !unit.success ||
    unit.numPassedTests !== unit.numTotalTests ||
    manifest.verification.unitTests.passed !== unit.numPassedTests ||
    manifest.verification.unitTests.total !== unit.numTotalTests
  )
    failures.push("自动测试报告与交付清单不一致");
  if (
    api.passed !== api.total ||
    manifest.verification.onlineApi.passed !== api.passed ||
    manifest.verification.onlineApi.total !== api.total ||
    !api.base.startsWith("https://")
  )
    failures.push("线上 API 报告与交付清单不一致");
  const local = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/integration-local-report.json"),
      "utf8",
    ),
  );
  if (
    local.passed !== local.total ||
    manifest.verification.localApi.passed !== local.passed
  )
    failures.push("本地 API 报告与交付清单不一致");
  const ux = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/ux-review-report.json"),
      "utf8",
    ),
  );
  if (
    ux.onlineRetest.passed !== ux.onlineRetest.total ||
    ux.onlineRetest.cases.length !== ux.onlineRetest.total ||
    ux.onlineRetest.cases.some((item) => !item.passed) ||
    manifest.verification.userExperienceReview.passed !==
      ux.onlineRetest.passed ||
    manifest.verification.userExperienceReview.total !==
      ux.onlineRetest.total ||
    manifest.workerVersion !== ux.workerVersion ||
    ux.cleanup.mainAgent.remainingTasks !== 0 ||
    ux.cleanup.mainAgent.remainingAlerts !== 0
  )
    failures.push("用户视角回归报告与交付清单不一致或测试数据未清理");
  for (const entry of ux.screenshots) {
    const file = path.join(packageRoot, entry.file);
    if (
      !fs.existsSync(file) ||
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex") !== entry.sha256
    )
      failures.push(`用户视角证据图缺失或校验不一致：${entry.file}`);
  }
  const delivery = fs.readFileSync(
    path.join(docRoot, "docs/DELIVERY.md"),
    "utf8",
  );
  if (!delivery.includes(`${manifest.video.durationSeconds} 秒`))
    failures.push("视频时长与交付说明不一致");
  for (const entry of manifest.files) {
    const file = path.join(packageRoot, entry.file);
    if (!fs.existsSync(file)) failures.push(`交付文件缺失：${entry.file}`);
    else if (
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex") !== entry.sha256
    )
      failures.push(`文件校验不一致：${entry.file}`);
  }
}
console.log(
  JSON.stringify(
    {
      documents: docs.length,
      internalLinks: links,
      packageReferences,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
