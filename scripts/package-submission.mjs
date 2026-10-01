import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const options = {
  evidence: path.join(root, "artifacts"),
  video: null,
  zip: false,
};
for (let i = 2; i < process.argv.length; ++i) {
  const arg = process.argv[i];
  if (arg === "--zip") options.zip = true;
  else if (["--video", "--evidence", "--output"].includes(arg)) {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
      throw new Error(`${arg} requires a path`);
    options[arg.slice(2)] = path.resolve(process.argv[++i]);
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (options.zip && !options.video)
  throw new Error(
    "新视频尚未提供；不能生成最终提交ZIP。请使用 --video 路径 --zip。",
  );
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const run = (command, args, config = {}) =>
  execFileSync(command, args, { cwd: root, ...config });
const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`不允许提交符号链接：${file}`);
    return e.isDirectory() ? walk(file) : [file];
  });
const project = readJson(path.join(root, "package.json"));
const productVersion = `v${project.version}`;
const gitRoot = run("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
if (fs.realpathSync(gitRoot) !== fs.realpathSync(root))
  throw new Error("请在项目Git仓库根目录运行整理命令。");
if (run("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw new Error(
    "请先提交已审查的源码和文档，再生成与Git版本一致的交付材料。",
  );
const gitCommit = run("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const submissions = path.join(root, "submission");
fs.mkdirSync(submissions, { recursive: true });
const dir =
  options.output ?? path.join(submissions, `待提交_知因雷达_${productVersion}`);
// Restrict replacement to a generated child of submission, never an arbitrary directory.
if (
  path.dirname(dir) !== submissions ||
  !path.basename(dir).startsWith("待提交_")
)
  throw new Error("输出目录必须是submission/下名称以待提交_开头的直接子目录。");
if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
  throw new Error("输出目录不能是符号链接。");
if (
  fs.existsSync(dir) &&
  !fs.existsSync(path.join(dir, "delivery-manifest.json"))
)
  throw new Error("输出目录不是本脚本生成的材料目录，不会覆盖。");
if (!options.video && fs.existsSync(path.join(dir, "演示视频.mp4")))
  throw new Error(
    "已有录屏，请用 --video 指向它以保留并更新材料；不会自动删除录屏。",
  );
if (fs.existsSync(dir)) {
  const existing = readJson(path.join(dir, "delivery-manifest.json"));
  if (existing.product !== "知因雷达" || !Array.isArray(existing.files))
    throw new Error("输出目录的清单无效，不会覆盖。");
  const known = new Set(
    existing.files.map((file) => path.join(dir, file.file)),
  );
  known.add(path.join(dir, "delivery-manifest.json"));
  if (options.video) known.add(options.video);
  for (const file of walk(dir)) {
    if (!known.has(file) && path.basename(file) !== ".DS_Store")
      throw new Error(
        `输出目录含未登记文件，不会覆盖：${path.relative(dir, file)}`,
      );
  }
}
const reports = [
  "unit-test-report.json",
  "integration-report.json",
  "integration-local-report.json",
  "integration-first-retrace.json",
  "integration-before-product-audit.json",
  "cron-proof.json",
  "cron-latest-proof.json",
  "ai-verification.json",
  "model-schedule-failure.json",
  "product-audit-report.json",
  "ux-review-report.json",
  "model-config-comparison.json",
  "model-config-selected.json",
  "ui-detail-review.json",
];
for (const file of reports)
  if (!fs.existsSync(path.join(options.evidence, file)))
    throw new Error(
      `缺少实际验证报告：${file}；可用 --evidence 指定已有verification目录。`,
    );

let video = {
  status: "pending",
  file: "演示视频.mp4",
  requiredDurationSeconds: [60, 180],
};
if (options.video) {
  if (path.extname(options.video).toLowerCase() !== ".mp4")
    throw new Error("请提供MP4成片；不通过改后缀冒充格式转换。");
  const ffprobe = fs.existsSync("/opt/homebrew/bin/ffprobe")
    ? "/opt/homebrew/bin/ffprobe"
    : "ffprobe";
  const probe = JSON.parse(
    run(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,format_name:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        options.video,
      ],
      { encoding: "utf8" },
    ),
  );
  const duration = Number(probe.format?.duration);
  const stream = probe.streams?.find((s) => s.codec_type === "video");
  if (
    !stream ||
    !Number.isFinite(duration) ||
    duration < 60 ||
    duration > 180 ||
    !probe.format?.format_name?.includes("mp4")
  )
    throw new Error("视频需为包含有效视频轨的MP4，成片时长60–180秒。");
  video = {
    status: "included",
    file: "演示视频.mp4",
    durationSeconds: duration,
    sizeBytes: Number(probe.format.size),
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    audio: probe.streams.some((s) => s.codec_type === "audio"),
    contentReview:
      "需观看确认操作覆盖、文字可读性及真实/演示标签；技术检查不替代内容核对",
  };
  video.sha256 = sha256(options.video);
  const reviewFile = "docs/VIDEO_REVIEW.md";
  if (fs.existsSync(path.join(root, reviewFile))) {
    const review = fs.readFileSync(path.join(root, reviewFile), "utf8");
    if (!review.includes(`视频SHA-256：\`${video.sha256}\``))
      throw new Error(
        "待打包视频与视频导览记录不一致，请复核并更新说明后重新整理。",
      );
    video.reviewFile = reviewFile;
    video.contentReview =
      "元数据与原尺寸关键帧已核对；具体覆盖和未完整展示的流程见视频导览，不冒称逐帧审查或额外后端测试";
  }
}

const temp = fs.mkdtempSync(path.join(submissions, ".prepare-"));
const staging = path.join(temp, "materials");
const sourceZip = path.join(submissions, `知因雷达_${productVersion}_源码.zip`);
const finalZip = `${dir}_完整提交.zip`;
let archiveSize = null;
try {
  fs.mkdirSync(staging);
  const sourceTar = path.join(temp, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${sourceTar}`, gitCommit]);
  run("tar", ["-xf", sourceTar, "-C", staging]);
  const verification = path.join(staging, "verification");
  fs.mkdirSync(verification);
  for (const file of reports)
    fs.copyFileSync(
      path.join(options.evidence, file),
      path.join(verification, file),
    );
  // Copy before replacing the old directory, including when --video refers inside it.
  if (options.video)
    fs.copyFileSync(options.video, path.join(staging, video.file));
  const unit = readJson(path.join(verification, "unit-test-report.json"));
  const api = readJson(path.join(verification, "integration-report.json"));
  const local = readJson(
    path.join(verification, "integration-local-report.json"),
  );
  const selected = readJson(
    path.join(verification, "model-config-selected.json"),
  );
  const ui = readJson(path.join(verification, "ui-detail-review.json"));
  const cron = readJson(path.join(verification, "cron-proof.json"));
  const latestCron = readJson(
    path.join(verification, "cron-latest-proof.json"),
  );
  const judge = readJson(path.join(verification, "product-audit-report.json"));
  const ux = readJson(path.join(verification, "ux-review-report.json"));
  for (const proof of [cron, latestCron])
    if (
      !proof.clientExitedBeforeRun ||
      proof.run.kind !== "cron" ||
      proof.run.status !== "complete"
    )
      throw new Error("缺少客户端退出后的真实Cron完成证据。");
  if (!ux.mainFlow.passed) throw new Error("用户主链路回归未通过。");
  let intro = fs
    .readFileSync(path.join(staging, "docs/DELIVERY.md"), "utf8")
    .replace(
      /(\[[^\]]*\]\()((?!https?:|mailto:|#)[^)]+)(\))/g,
      (_, before, target, after) =>
        before + path.posix.join("docs", target) + after,
    );
  const reviewStatus = video.reviewFile
    ? "元数据与关键画面核对完成，实际覆盖见[视频导览](docs/VIDEO_REVIEW.md)。"
    : "技术格式检查通过；请观看确认操作覆盖与文字可读性。";
  const status = options.video
    ? `**视频已加入：${video.durationSeconds} 秒，${video.width} × ${video.height}。** ${reviewStatus}最终上传包含全部材料和视频的一个ZIP，小于30MB。`
    : "**尚缺用户新版录屏；此目录暂不可直接作为完整答案提交。** 请按docs/RECORDING_GUIDE.md录制60–180秒成片；提供文件位置后更新材料。旧视频没有加入本目录。";
  intro =
    `# 当前材料状态\n\n${status}\n\n源码版本：\`${gitCommit}\`。文件清单见\`delivery-manifest.json\`。\n\n` +
    intro;
  fs.writeFileSync(path.join(staging, "00_提交说明.md"), intro);

  const files = walk(staging);
  const secretFile = path.join(root, ".env.deploy-secrets.json");
  const secrets = fs.existsSync(secretFile)
    ? Object.values(readJson(secretFile)).filter(
        (s) => typeof s === "string" && s.length > 8,
      )
    : [];
  for (const file of files) {
    const name = path.relative(staging, file);
    if (
      /(^|\/)(node_modules|\.git|\.wrangler|output|artifacts|record-profile)(\/|$)|(^|\/)\.dev\.vars|(^|\/)\.env(?!\.example$)|\.(webm|mov|mkv|zip|log)$|候选人附件_|01_AI驱动|13_投资/.test(
        name,
      )
    )
      throw new Error(`排除文件进入提交目录：${name}`);
    if (secrets.some((s) => fs.readFileSync(file).includes(Buffer.from(s))))
      throw new Error(`凭证排除检查失败：${name}`);
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    product: "知因雷达",
    productVersion,
    examQuestion: "第一题：可配置投资监控与风险雷达",
    gitCommit,
    webUrl: "https://zhiyin-risk-radar.dimyoung-0719.workers.dev",
    sourceRepository: "https://github.com/DimYoung-lab/zhiyin-risk-radar",
    workerVersion: ui.workerVersion,
    readyForSubmission: Boolean(options.video),
    readinessScope: video.reviewFile
      ? "文件齐全与技术校验；视频关键画面核对范围见视频导览，最终ZIP须小于30MB"
      : "文件齐全与技术校验；视频内容须人工观看确认，最终ZIP须小于30MB",
    outstandingItems: options.video ? [] : ["用户录制的60–180秒新版演示视频"],
    verification: {
      unitTests: {
        passed: unit.numPassedTests,
        total: unit.numTotalTests,
        startedAt: new Date(unit.startTime).toISOString(),
      },
      onlineApi: {
        passed: api.passed,
        total: api.total,
        at: api.at,
        testedWorkerVersion: api.workerVersion,
      },
      localApi: { passed: local.passed, total: local.total, at: local.at },
      realCron: {
        clientExitedBeforeRun: true,
        runId: cron.run.id,
        kind: cron.run.kind,
        observedAt: cron.observedAt,
      },
      latestRealCron: {
        clientExitedBeforeRun: true,
        runId: latestCron.run.id,
        kind: latestCron.run.kind,
        observedAt: latestCron.observedAt,
      },
      independentProductAudit: {
        score: judge.score,
        total: judge.total,
        officialExamScore: false,
        stage: "original_product_review",
      },
      userExperienceReview: {
        passed: ux.onlineRetest.passed,
        total: ux.onlineRetest.total,
        onlineActor: ux.onlineRetest.actor,
        independentLocal: ux.independentReview.localRetest,
        at: ux.at,
        testedWorkerVersion: ux.workerVersion,
        reportFile: "verification/ux-review-report.json",
      },
      modelConfiguration: {
        comparisonReport: "verification/model-config-comparison.json",
        selectedReport: "verification/model-config-selected.json",
        configuration: selected.configurations.selected,
        passed: selected.summaries[0].passed,
        total: selected.summaries[0].total,
        at: selected.at,
      },
      uiDetailReview: {
        passed: ui.passed,
        total: ui.total,
        at: ui.at,
        testedWorkerVersion: ui.workerVersion,
        localRetest: ui.localRetest,
        reportFile: "verification/ui-detail-review.json",
      },
      latestChangeScope:
        "Submission documentation and packaging only. Existing source-bound test evidence retains its actual execution times and deployed versions.",
    },
    video,
    uploadLimitBytes: 30_000_000,
    credentialScan: {
      result: "passed",
      localKnownSecretValuesChecked: secrets.length > 0,
      excludedRuntimeFiles: true,
    },
    fileHashAlgorithm: "SHA-256",
    fileHashesExclude: "delivery-manifest.json itself",
    files: files
      .map((file) => ({
        file: path.relative(staging, file).split(path.sep).join("/"),
        sizeBytes: fs.statSync(file).size,
        sha256: sha256(file),
      }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
  fs.writeFileSync(
    path.join(staging, "delivery-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  run(process.execPath, ["scripts/check-docs.mjs", staging], {
    stdio: "inherit",
  });
  const stagedSourceZip = path.join(temp, "source.zip");
  run("git", [
    "archive",
    "--format=zip",
    `--output=${stagedSourceZip}`,
    gitCommit,
  ]);
  run("unzip", ["-tqq", stagedSourceZip]);
  let stagedFinalZip;
  if (options.zip) {
    const zipRoot = path.join(temp, "archive");
    fs.mkdirSync(zipRoot);
    const zipFolder = path.join(zipRoot, path.basename(dir));
    fs.cpSync(staging, zipFolder, { recursive: true });
    stagedFinalZip = path.join(temp, "complete.zip");
    run("zip", ["-q", "-r", "-X", stagedFinalZip, path.basename(dir)], {
      cwd: zipRoot,
    });
    run("unzip", ["-tqq", stagedFinalZip]);
    archiveSize = fs.statSync(stagedFinalZip).size;
    if (archiveSize >= 30_000_000)
      throw new Error("最终ZIP不小于30MB，请压缩视频后重新整理。");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  fs.copyFileSync(stagedSourceZip, sourceZip);
  fs.writeFileSync(
    `${sourceZip}.sha256`,
    `${sha256(sourceZip)}  ${path.basename(sourceZip)}\n`,
  );
  // Prevent a previous final ZIP being mistaken for this newly prepared material.
  fs.rmSync(finalZip, { force: true });
  fs.rmSync(`${finalZip}.sha256`, { force: true });
  if (stagedFinalZip) {
    fs.copyFileSync(stagedFinalZip, finalZip);
    fs.writeFileSync(
      `${finalZip}.sha256`,
      `${sha256(finalZip)}  ${path.basename(finalZip)}\n`,
    );
  }
  console.log(
    JSON.stringify(
      {
        directory: dir,
        sourceZip,
        sourceZipBytes: fs.statSync(sourceZip).size,
        sourceZipSHA256: sha256(sourceZip),
        gitCommit,
        fileCount: manifest.files.length + 1,
        materialBytes: walk(dir).reduce(
          (sum, file) => sum + fs.statSync(file).size,
          0,
        ),
        readyForSubmission: manifest.readyForSubmission,
        outstandingItems: manifest.outstandingItems,
        video,
        finalZip: options.zip ? finalZip : null,
        finalZipBytes: archiveSize,
        crossReferences: "passed",
        fileHashes: "passed",
        credentialScan: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
