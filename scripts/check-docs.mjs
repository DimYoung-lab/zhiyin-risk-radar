import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const packageRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const docRoot = packageRoot ?? root;
const manifest = packageRoot
  ? JSON.parse(
      fs.readFileSync(path.join(packageRoot, "delivery-manifest.json"), "utf8"),
    )
  : null;
const videoPending = manifest?.video?.status === "pending";
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
      if (match[1] === "演示视频.mp4" && videoPending) continue;
      if (!fs.existsSync(path.join(packageRoot, match[1])))
        failures.push(`${path.relative(docRoot, doc)} → package:${match[1]}`);
    }
  }
}
if (packageRoot) {
  const project = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package-lock.json"), "utf8"),
  );
  if (
    project.version !== lock.version ||
    project.version !== lock.packages[""].version ||
    manifest.productVersion !== `v${project.version}`
  )
    failures.push("产品版本与依赖锁文件或交付清单不一致");
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
    manifest.verification.onlineApi.at !== api.at ||
    manifest.verification.onlineApi.testedWorkerVersion !== api.workerVersion ||
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(path.join(packageRoot, "src/server/providers.ts")),
      )
      .digest("hex") !== api.sourceAdapterSHA256 ||
    !api.base.startsWith("https://")
  )
    failures.push("线上 API 报告与交付清单不一致");
  const selected = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/model-config-selected.json"),
      "utf8",
    ),
  );
  const comparison = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/model-config-comparison.json"),
      "utf8",
    ),
  );
  const modelVerification = manifest.verification.modelConfiguration;
  const modelSummary = selected.summaries[0];
  if (
    selected.reasoningContentStored !== false ||
    comparison.reasoningContentStored !== false ||
    selected.results.length !== modelSummary.total ||
    modelSummary.passed !== modelSummary.total ||
    selected.results.some(
      (item) => !item.passed || item.finishReason !== "stop",
    ) ||
    comparison.results.some((item) => !item.passed) ||
    modelVerification?.passed !== modelSummary.passed ||
    modelVerification?.total !== modelSummary.total ||
    modelVerification?.at !== selected.at ||
    JSON.stringify(modelVerification?.configuration) !==
      JSON.stringify(selected.configurations.selected) ||
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(path.join(packageRoot, selected.productionAdapter)),
      )
      .digest("hex") !== selected.adapterSHA256
  )
    failures.push("模型配置报告与适配器源码或交付清单不一致");
  const uiDetails = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "verification/ui-detail-review.json"),
      "utf8",
    ),
  );
  const uiManifest = manifest.verification.uiDetailReview;
  if (
    uiDetails.passed !== uiDetails.total ||
    uiDetails.cases.length !== uiDetails.total ||
    uiDetails.cases.some((item) => !item.passed) ||
    uiDetails.localRetest.passed !== uiDetails.localRetest.total ||
    uiDetails.remainingTasks !== 0 ||
    uiDetails.remainingAlerts !== 0 ||
    uiDetails.pageErrors.length !== 0 ||
    uiManifest?.passed !== uiDetails.passed ||
    uiManifest?.total !== uiDetails.total ||
    uiManifest?.at !== uiDetails.at ||
    uiManifest?.testedWorkerVersion !== uiDetails.workerVersion ||
    manifest.workerVersion !== uiDetails.workerVersion
  )
    failures.push("表单细节回归报告与当前部署或交付清单不一致");
  for (const [file, expected] of Object.entries(uiDetails.sourceHashes)) {
    if (
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(packageRoot, file)))
        .digest("hex") !== expected
    )
      failures.push(`表单细节回归与前端源码不一致：${file}`);
  }
  for (const screenshot of uiDetails.screenshots) {
    const file = path.join(packageRoot, screenshot.file);
    if (
      !fs.existsSync(file) ||
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex") !== screenshot.sha256
    )
      failures.push(`表单细节证据图缺失或校验不一致：${screenshot.file}`);
  }
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
    manifest.verification.userExperienceReview.testedWorkerVersion !==
      ux.workerVersion ||
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
  const intro = fs.readFileSync(path.join(docRoot, "00_提交说明.md"), "utf8");
  const videoFile = path.join(packageRoot, "演示视频.mp4");
  if (videoPending) {
    if (
      manifest.readyForSubmission !== false ||
      !manifest.outstandingItems?.length ||
      fs.existsSync(videoFile) ||
      !intro.includes("尚缺用户新版录屏")
    )
      failures.push(
        "待录屏状态与材料不一致；加入视频后须重新整理元数据与校验清单",
      );
  } else if (
    manifest.video.status !== "included" ||
    manifest.readyForSubmission !== true ||
    manifest.outstandingItems?.length !== 0 ||
    !fs.existsSync(videoFile) ||
    !Number.isFinite(manifest.video.durationSeconds) ||
    manifest.video.durationSeconds < 60 ||
    manifest.video.durationSeconds > 180 ||
    !intro.includes(`${manifest.video.durationSeconds} 秒`) ||
    (fs.existsSync(videoFile) &&
      fs.statSync(videoFile).size !== manifest.video.sizeBytes)
  )
    failures.push("视频信息、时长或提交状态与实际文件不一致");
  const listedFiles = new Set(manifest.files.map((entry) => entry.file));
  if (
    listedFiles.size !== manifest.files.length ||
    listedFiles.has("delivery-manifest.json")
  )
    failures.push("文件清单重复或包含自身，不能有效校验");
  for (const file of walk(packageRoot)) {
    const name = path.relative(packageRoot, file).split(path.sep).join("/");
    if (name !== "delivery-manifest.json" && !listedFiles.has(name))
      failures.push(`交付目录含未登记文件：${name}`);
  }
  for (const entry of manifest.files) {
    const file = path.join(packageRoot, entry.file);
    if (!fs.existsSync(file)) failures.push(`交付文件缺失：${entry.file}`);
    else if (
      fs.statSync(file).size !== entry.sizeBytes ||
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
      ...(manifest
        ? {
            materialChecks: failures.length ? "failed" : "passed",
            readyForSubmission: manifest.readyForSubmission,
            outstandingItems: manifest.outstandingItems,
            readinessScope: manifest.readinessScope,
          }
        : {}),
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
