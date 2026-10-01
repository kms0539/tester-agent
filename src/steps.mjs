// 시나리오(JSON)를 Forge 사용 순서대로 단계 목록으로 만든다.
// 각 단계는 사용자가 화면에서 누르는 버튼과 같은 API를 같은 순서로 부른다.

import { exec, execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { StepFailure } from "./runner.mjs";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const PLAN_TIMEOUT = 6 * 60_000;
const PIPELINE_TIMEOUT = 40 * 60_000;
const POLL_MS = 3000;

export function buildSteps(scenario) {
  const steps = [
    createProject(),
    ...(scenario.publish ? [connectRemote()] : []),
    ...setupSteps(),
  ];

  for (const task of scenario.tasks) {
    steps.push(...taskSteps(task, scenario));
  }

  if (scenario.hostCheck) steps.push(hostCheck(scenario.hostCheck));
  return steps;
}

// ─── 프로젝트 ───────────────────────────────────────────────

// 만든 저장소의 커밋 작성자를 tester-agent 저장소의 로컬 git 사용자로 맞춘다.
// 없으면 전역 설정(회사 계정 등)으로 커밋돼 개인 원격에 그대로 올릴 수 없다.
async function copyGitIdentity(repositoryPath) {
  for (const key of ["user.name", "user.email"]) {
    const value = await execFileAsync("git", ["config", "--local", key], { cwd: import.meta.dirname })
      .then(({ stdout }) => stdout.trim(), () => "");
    if (value) await execFileAsync("git", ["-C", repositoryPath, "config", key, value]);
  }
}

function createProject() {
  return {
    id: "project:create",
    title: "새 프로젝트 만들기(빈 저장소)",

    async run(ctx) {
      const created = await ctx.api.post("/forge/projects/create", {
        name: ctx.scenario.name,
        goal: ctx.scenario.goal,
        blankRepositoryPath: ctx.repositoryPath,
      });
      ctx.data.projectId = created.project.id;
      await copyGitIdentity(ctx.repositoryPath);
    },

    async check(ctx) {
      if (!ctx.data.projectId) return false;
      const { project } = await read(ctx);
      return project.bases?.length > 0;
    },
  };
}

// 빈 저장소면 Forge가 '기술 스택 결정' 작업을 먼저 만든다. 시나리오의 스택 결정으로 마친다.
function setupSteps() {
  return [
    {
      id: "setup:plan",
      title: "기술 스택 결정 · AI 플랜 생성·채택",
      run: async (ctx) => generateAndAdoptPlan(ctx, (await setupTask(ctx)).id),
      check: async (ctx) => {
        const task = await setupTask(ctx);
        return !task || hasCurrentPlan(task);
      },
    },
    {
      id: "setup:approve",
      title: "기술 스택 결정 · 플랜 승인",
      run: async (ctx) => approvePlan(ctx, (await setupTask(ctx)).id),
      check: async (ctx) => {
        const task = await setupTask(ctx);
        return !task || isApproved(task);
      },
    },
    {
      id: "setup:policy",
      title: "기술 스택 결정 · 공통 정책 반영",
      async run(ctx) {
        const { commit } = await read(ctx);
        await ctx.api.post("/forge/basis/plan-to-policy", {
          projectId: ctx.data.projectId,
          expectedCommit: commit,
          taskId: (await setupTask(ctx)).id,
          language: ctx.scenario.stack.language,
          decision: ctx.scenario.stack.decision,
        });
      },
      check: async (ctx) => {
        const task = await setupTask(ctx);
        return !task || task.status === "done";
      },
    },
  ];
}

// ─── 작업 하나 ──────────────────────────────────────────────

function taskSteps(spec, scenario) {
  const key = spec.key;
  const taskId = (ctx) => ctx.data.tasks?.[key]?.id;
  const current = async (ctx) => findTask((await read(ctx)).project, taskId(ctx));

  return [
    {
      id: `task:${key}:create`,
      title: `${spec.title} · 작업과 요구사항 저장`,
      async run(ctx) {
        const { commit } = await read(ctx);
        const snapshot = await ctx.api.post("/forge/tasks/create", {
          projectId: ctx.data.projectId,
          expectedCommit: commit,
          title: spec.title,
          requirement: spec.requirement,
        });
        ctx.data.tasks ??= {};
        ctx.data.tasks[key] = { id: snapshot.project.tasks.at(-1).id };
      },
      check: async (ctx) => Boolean(taskId(ctx) && await current(ctx)),
    },
    ...(spec.dependsOn?.length ? [dependencyStep(spec, taskId, current)] : []),
    {
      id: `task:${key}:plan`,
      title: `${spec.title} · AI 플랜 생성·채택`,
      run: async (ctx) => generateAndAdoptPlan(ctx, taskId(ctx)),
      check: async (ctx) => hasCurrentPlan(await current(ctx)),
    },
    {
      id: `task:${key}:approve`,
      title: `${spec.title} · 플랜 승인`,
      run: async (ctx) => approvePlan(ctx, taskId(ctx)),
      check: async (ctx) => isApproved(await current(ctx)),
    },
    {
      id: `task:${key}:develop`,
      title: `${spec.title} · AI 개발 원사이클(개발→검증→QA)`,
      run: async (ctx) => develop(ctx, key, spec, scenario),
      check: async (ctx) => qaPassedOnCurrentCode(await current(ctx)),
    },
    {
      id: `task:${key}:apply`,
      title: `${spec.title} · 원본 저장소에 반영`,
      async run(ctx) {
        const { commit } = await read(ctx);
        const task = await current(ctx);
        await ctx.api.post("/forge/code/apply", {
          projectId: ctx.data.projectId,
          taskId: task.id,
          checkpointId: task.currentCheckpointId,
          expectedCommit: commit,
          reason: "검증·QA 통과 코드 반영",
          reviewed: true,
        });
      },
      check: async (ctx) => {
        const task = await current(ctx);
        const last = task?.applications?.at(-1);
        return last?.status === "applied" && last.scope?.checkpointId === task.currentCheckpointId;
      },
    },
    ...(scenario.publish ? [publishStep(spec, taskId, current)] : []),
    {
      id: `task:${key}:report`,
      title: `${spec.title} · 결과 보고서 저장`,
      async run(ctx) {
        const { drafts } = await ctx.api.post("/forge/tasks/document-drafts", {
          projectId: ctx.data.projectId,
          taskId: taskId(ctx),
        });
        const { commit } = await read(ctx);
        await ctx.api.post("/forge/tasks/report", {
          projectId: ctx.data.projectId,
          taskId: taskId(ctx),
          expectedCommit: commit,
          documents: drafts,
          reason: "현재 기록으로 조립한 보고서 저장",
        });
      },
      check: async (ctx) => {
        const task = await current(ctx);
        const kinds = ["development", "verification", "rollback", "handoff"];
        return kinds.every((kind) => {
          const document = task?.documents?.findLast((item) => item.kind === kind);
          return document?.scope?.checkpointId === task.currentCheckpointId;
        });
      },
    },
    {
      id: `task:${key}:complete`,
      title: `${spec.title} · 완료 기록`,
      async run(ctx) {
        const { commit } = await read(ctx);
        await ctx.api.post("/forge/tasks/complete", {
          projectId: ctx.data.projectId,
          taskId: taskId(ctx),
          expectedCommit: commit,
          application: "applied",
          reason: "구현·검증·QA 통과 후 원본 반영 확인",
        });
      },
      check: async (ctx) => (await current(ctx))?.status === "done",
    },
  ];
}

// 원사이클을 돌린다. QA가 보완 필요로 끝나면 사람처럼 다시 누르고(재개발),
// AI가 질문만 남기면 시나리오의 보충 설명으로 요구사항을 고쳐 플랜부터 다시 한다.
export async function develop(ctx, key, spec, scenario) {
  const state = ctx.data.tasks[key];
  const manualReworks = spec.maxManualRework ?? scenario.maxManualRework ?? 1;
  let reworks = 0;

  for (;;) {
    const result = await runPipeline(ctx, state.id, spec.maxAutoRework ?? 1, spec.files ?? []);

    if (result.status === "succeeded" && result.latestQaOutcome === "pass") return;

    // AI가 코드 대신 질문을 남겼다. 사람처럼 시나리오의 보충 설명으로 범위 안에서 답하고 같은 플랜으로 이어 간다.
    if (result.question) {
      if (!spec.clarification || state.clarified) {
        throw new StepFailure("human", "AI가 코드 대신 확인 질문을 남겼습니다.", { question: result.question });
      }
      await clarify(ctx, state.id, result.question, spec.clarification);
      state.clarified = true;
      ctx.log("  ↪ AI 질문에 시나리오의 보충 설명으로 답하고 이어서 개발");
      continue;
    }

    if (result.latestQaOutcome === "fail" && reworks < manualReworks) {
      reworks++;
      ctx.log(`  ↻ QA 보완 필요 → 재개발 (${reworks}/${manualReworks})`);
      continue;
    }

    const kind = aiLimitHit(result.error) ? "human"
      : result.status === "cancelled" ? "forge"
        : result.latestQaOutcome === "fail" ? "quality" : "forge";
    throw new StepFailure(kind, result.summary || result.error || `원사이클 ${result.status}`, {
      error: result.error,
      logs: result.logs?.slice(-20),
    });
  }
}

// 선행 작업 연결. 화면의 '선행 작업' 체크와 같다. 플랜보다 먼저 둬야 플랜이 선행 작업을 근거로 쓴다.
function dependencyStep(spec, taskId, current) {
  const ids = (ctx) => spec.dependsOn.map((key) => ctx.data.tasks[key].id);
  return {
    id: `task:${spec.key}:depends`,
    title: `${spec.title} · 선행 작업 연결 (${spec.dependsOn.join(", ")})`,
    async run(ctx) {
      const { commit } = await read(ctx);
      await ctx.api.post("/forge/tasks/dependencies", {
        projectId: ctx.data.projectId,
        taskId: taskId(ctx),
        expectedCommit: commit,
        dependencies: ids(ctx),
        reason: "시나리오의 작업 순서",
      });
    },
    check: async (ctx) => {
      const linked = (await current(ctx))?.dependencies ?? [];
      return ids(ctx).every((id) => linked.includes(id));
    },
  };
}

async function clarify(ctx, taskId, question, answer) {
  const { commit } = await read(ctx);
  await ctx.api.post("/forge/tasks/clarify", {
    projectId: ctx.data.projectId,
    taskId,
    expectedCommit: commit,
    question,
    answer,
  });
}

async function runPipeline(ctx, taskId, maxAutoRework, files) {
  const { commit } = await read(ctx);
  const { jobId } = await ctx.api.post("/forge/pipeline/start", {
    projectId: ctx.data.projectId,
    taskId,
    expectedCommit: commit,
    engine: ctx.ai.engine,
    model: ctx.ai.model,
    files,
    references: [],
    reason: "승인한 플랜 구현",
    verifyImage: ctx.verifyImage,
    verifyCommand: ctx.scenario.verify?.command ?? "",
    verifyNetwork: true,
    maxAutoRework,
  });

  const deadline = Date.now() + PIPELINE_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(ctx.pollMs ?? POLL_MS);
    const job = await ctx.api.post("/forge/pipeline/status", { projectId: ctx.data.projectId, taskId, jobId });
    if (job.status !== "running") return job;
  }
  throw new StepFailure("forge", `원사이클이 ${PIPELINE_TIMEOUT / 60_000}분 안에 끝나지 않았습니다.`);
}

// ─── 커밋·push ───────────────────────────────────────────────

// 실제 GitHub 대신 실행 폴더 안의 bare 저장소를 origin으로 둔다. Forge의 '커밋하고 push'를 끝까지 시험한다.
function connectRemote() {
  return {
    id: "project:remote",
    title: "원격 저장소(origin) 연결",
    async run(ctx) {
      const remote = join(ctx.runDir, "remote.git");
      await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
      await execFileAsync("git", ["-C", ctx.repositoryPath, "remote", "add", "origin", remote]);
    },
    async check(ctx) {
      const { stdout } = await execFileAsync("git", ["-C", ctx.repositoryPath, "remote", "get-url", "origin"]);
      return stdout.trim() === join(ctx.runDir, "remote.git");
    },
  };
}

function publishStep(spec, taskId, current) {
  return {
    id: `task:${spec.key}:publish`,
    title: `${spec.title} · 커밋하고 push`,
    async run(ctx) {
      const { commit } = await read(ctx);
      await ctx.api.post("/forge/code/publish", {
        projectId: ctx.data.projectId,
        taskId: taskId(ctx),
        expectedCommit: commit,
        message: `feat: ${spec.title}`,
        branch: "",
      });
    },
    // Forge 기록뿐 아니라 원격 저장소에 그 커밋이 실제로 올라갔는지 본다.
    async check(ctx) {
      const task = await current(ctx);
      const applied = task?.applications?.findLast((item) => item.status === "applied");
      const published = task?.publications?.findLast((item) => item.applicationId === applied?.id);
      if (!published) return false;
      const { stdout } = await execFileAsync("git", ["--git-dir", join(ctx.runDir, "remote.git"), "rev-parse", published.branch]);
      return stdout.trim() === published.commit;
    },
  };
}

// ─── 플랜 ───────────────────────────────────────────────────

// 화면의 'AI로 플랜 초안 생성'과 같다. 현재 기준의 코드 체크포인트가 없으면 먼저 보존한다.
async function generateAndAdoptPlan(ctx, taskId) {
  let { project, commit } = await read(ctx);
  const task = findTask(project, taskId);
  const checkpoint = task.checkpoints?.find((item) => item.id === task.currentCheckpointId);
  const basisId = task.basisId ?? project.activeBasisId;

  if (!checkpoint || checkpoint.basisId !== basisId) {
    ({ commit } = await ctx.api.post("/forge/code/capture", {
      projectId: ctx.data.projectId,
      taskId,
      expectedCommit: commit,
      reason: "AI 플랜 작성 전 현재 코드 보존",
    }));
  }

  const started = await ctx.api.post("/forge/runs/start", {
    projectId: ctx.data.projectId,
    taskId,
    expectedCommit: commit,
    purpose: "plan",
    engine: ctx.ai.engine,
    model: ctx.ai.model,
    files: [],
    references: [],
    reason: "AI 플랜 초안 작성",
  });
  const run = findTask(started.project, taskId).runs.at(-1);
  const finished = await waitForRun(ctx, taskId, run.id, PLAN_TIMEOUT);

  if (finished.status !== "succeeded") {
    throw new StepFailure(aiLimitHit(finished.error) ? "human" : "forge", `AI 플랜 실행이 ${finished.status}로 끝났습니다: ${finished.error ?? ""}`, {
      errorCode: finished.errorCode,
    });
  }

  const latest = await read(ctx);
  await ctx.api.post("/forge/runs/adopt", {
    projectId: ctx.data.projectId,
    taskId,
    runId: run.id,
    expectedCommit: latest.commit,
    reason: "AI 플랜 초안 검토 후 채택",
  });
}

async function approvePlan(ctx, taskId) {
  const { project, commit } = await read(ctx);
  await ctx.api.post("/forge/plans/approve", {
    projectId: ctx.data.projectId,
    expectedCommit: commit,
    taskId,
    planId: findTask(project, taskId).currentPlanId,
  });
}

// AI 구독 사용량 한도. Forge 문제가 아니므로 고치지 않고 사람에게(기다리거나 엔진 바꾸기) 넘긴다.
const aiLimitHit = (text) => /사용량 한도/.test(text ?? "");

async function waitForRun(ctx, taskId, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(ctx.pollMs ?? POLL_MS);
    const status = await ctx.api.post("/forge/runs/status", { projectId: ctx.data.projectId, taskId, runId });
    if (status.recoveryRequired) {
      throw new StepFailure("forge", "실행 기록은 진행 중인데 서버에 실행이 없습니다(중단 복구 필요).");
    }
    if (!["starting", "running", "stopping"].includes(status.run.status)) return status.run;
  }
  throw new StepFailure("forge", `AI 실행이 ${timeoutMs / 60_000}분 안에 끝나지 않았습니다.`);
}

// ─── 마지막: 사용자 PC에서 직접 확인 ─────────────────────────

// Forge 안의 검증과 별개로, 반영된 저장소를 이 PC에서 실제로 돌려 본다.
function hostCheck(command) {
  return {
    id: "final:host-check",
    title: `반영된 저장소를 이 PC에서 확인 (${command})`,
    async run(ctx) {
      try {
        await execAsync(command, { cwd: ctx.repositoryPath, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (error) {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n").slice(-40).join("\n");
        throw new StepFailure("product", `이 PC에서 '${command}'가 실패했습니다.`, { output });
      }
    },
  };
}

// ─── 상태 읽기 ──────────────────────────────────────────────

function read(ctx) {
  return ctx.api.post("/forge/project", { projectId: ctx.data.projectId });
}

function findTask(project, taskId) {
  return project.tasks.find((item) => item.id === taskId);
}

async function setupTask(ctx) {
  const { project } = await read(ctx);
  return project.tasks.find((item) => item.kind === "setup");
}

function hasCurrentPlan(task) {
  const plan = task?.plans?.find((item) => item.id === task.currentPlanId);
  return Boolean(plan && plan.requirementId === task.activeRequirementId);
}

function isApproved(task) {
  return hasCurrentPlan(task) && task.approvedPlanId === task.currentPlanId;
}

function qaPassedOnCurrentCode(task) {
  const qa = task?.qaRecords?.at(-1);
  return Boolean(qa && qa.outcome === "pass" && qa.scope?.checkpointId === task.currentCheckpointId);
}
