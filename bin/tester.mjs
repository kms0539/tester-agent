#!/usr/bin/env node
// tester-agent 실행 진입점.
//
//   node bin/tester.mjs run <시나리오.json> [--fix] [--engine claude|codex]
//   node bin/tester.mjs resume <runId> [--fix] [--engine claude|codex]
//   node bin/tester.mjs list
//
// --fix 를 주면 막혔을 때 AI에게 Forge 수정을 맡기고, 통과하면 직전 단계부터 이어 간다.

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createForgeApi } from "../src/forge-api.mjs";
import { createForgeServer } from "../src/forge-server.mjs";
import { createImprover } from "../src/improver.mjs";
import { openJournal } from "../src/journal.mjs";
import { runSteps } from "../src/runner.mjs";
import { summarizeProject } from "../src/snapshot.mjs";
import { buildSteps } from "../src/steps.mjs";
import { writeSummary } from "../src/summary.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, "runs");

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    fix: { type: "boolean", default: false },
    engine: { type: "string", default: "claude" },
    forge: { type: "string", default: process.env.TESTER_FORGE_DIR ?? resolve(ROOT, "../forge-harness") },
    port: { type: "string", default: process.env.TESTER_FORGE_PORT ?? "3291" },
  },
});

const [command, target] = positionals;

if (command === "run" && target) await start(resolve(target));
else if (command === "resume" && target) await resume(target);
else if (command === "list") await list();
else {
  console.log("사용법: tester run <시나리오.json> [--fix] | tester resume <runId> [--fix] | tester list");
  process.exitCode = 1;
}

// ─── 명령 ───────────────────────────────────────────────────

async function start(scenarioFile) {
  const scenario = JSON.parse(await readFile(scenarioFile, "utf8"));
  const runId = `${localStamp()}-${scenario.name}`;
  const runDir = join(RUNS, runId);
  const journal = await openJournal(runDir, {
    runId,
    scenarioFile,
    repositoryPath: join(runDir, "repos", scenario.name),
  });
  await execute(journal, scenario);
}

async function resume(runId) {
  const journal = await openJournal(join(RUNS, runId));
  if (!journal.state.scenarioFile) throw new Error(`실행 기록을 찾을 수 없습니다: ${runId}`);
  const scenario = JSON.parse(await readFile(journal.state.scenarioFile, "utf8"));
  journal.state.status = "running";
  await execute(journal, scenario);
}

async function list() {
  const names = await readdir(RUNS).catch(() => []);
  for (const name of names.sort()) {
    const state = JSON.parse(await readFile(join(RUNS, name, "journal.json"), "utf8").catch(() => "{}"));
    console.log(`${name}  ${state.status ?? "?"}  완료 ${state.done?.length ?? 0}단계  실패 ${state.failures?.length ?? 0}  수정 ${state.fixes?.length ?? 0}`);
  }
}

// 실행 ID에 쓰는 이 PC 기준 시각 (예: 20261001-1417)
function localStamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// ─── 실행 ───────────────────────────────────────────────────

async function execute(journal, scenario) {
  const runDir = journal.runDir;
  const log = (line) => console.log(`[${new Date().toLocaleTimeString("ko-KR")}] ${line}`);

  const server = createForgeServer({
    forgeDir: options.forge,
    port: Number(options.port),
    dataRoot: join(runDir, "forge-data"),
    repositoryRoot: join(runDir, "repos"),
    logFile: join(runDir, "forge.log"),
  });
  const api = createForgeApi({ baseUrl: `http://127.0.0.1:${options.port}` });

  const ctx = {
    api,
    scenario,
    data: journal.data,
    log,
    ai: scenario.ai ?? { engine: "codex", model: "" },
    runDir,
    repositoryPath: journal.state.repositoryPath,
    // 실행 검증은 이 PC와 같은 Node 버전 이미지로 돌린다.
    verifyImage: scenario.verify?.image ?? `node:${process.versions.node}-slim`,
  };

  const onFailure = options.fix
    ? createImprover({
      forgeDir: options.forge,
      engine: options.engine,
      runDir,
      server,
      log,
      snapshot: () => summarizeProject(api, ctx.data.projectId),
    })
    : null;

  // Ctrl+C로 끊어도 Forge가 소유권을 반납하고 끝나게 한다. 다음에 resume으로 이어 간다.
  process.once("SIGINT", async () => {
    log("중단 요청 — Forge를 정리하고 끝냅니다. 이어 하려면: tester resume " + basename(runDir));
    await journal.finish("interrupted");
    await server.stop();
    process.exit(130);
  });

  log(`실행 ${basename(runDir)} · 시나리오 ${scenario.name} · Forge ${options.forge}`);
  await server.start();
  try {
    const result = await runSteps({ steps: buildSteps(scenario), journal, ctx, onFailure, log });
    log(result.status === "passed" ? "결과: 통과" : `결과: 멈춤 — ${result.note}`);
    process.exitCode = result.status === "passed" ? 0 : 2;
  } finally {
    await server.stop();
    log(`요약: ${await writeSummary(journal, scenario)}`);
  }
}
