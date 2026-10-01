import assert from "node:assert/strict";
import test from "node:test";
import { GoBack, StepFailure } from "../src/runner.mjs";
import { buildSteps, develop } from "../src/steps.mjs";

const scenario = {
  name: "demo",
  goal: "데모",
  stack: { language: "typescript", decision: "TS" },
  hostCheck: "npm test",
  tasks: [{ key: "a", title: "A", requirement: "요구", clarification: "보충" }],
};

// 원사이클 결과를 차례로 돌려주는 가짜 Forge.
function fakeForge(jobs) {
  const calls = [];
  const task = { id: "t1", activeRequirementId: "r1", requirements: [{ id: "r1", text: "요구" }] };
  const api = {
    async post(path, body) {
      calls.push({ path, body });
      if (path === "/forge/project") return { commit: "c1", project: { tasks: [task] } };
      if (path === "/forge/pipeline/start") return { jobId: `job${calls.length}` };
      if (path === "/forge/pipeline/status") return jobs.shift();
      return {};
    },
  };
  return { api, calls };
}

function ctxWith(api) {
  return {
    api,
    scenario,
    data: { projectId: "p1", tasks: { a: { id: "t1" } } },
    ai: { engine: "codex", model: "m" },
    verifyImage: "node:22-slim",
    pollMs: 1,
    log: () => {},
  };
}

test("시나리오를 Forge 사용 순서대로 단계로 만든다", () => {
  const ids = buildSteps(scenario).map((step) => step.id);
  assert.deepEqual(ids, [
    "project:create", "setup:plan", "setup:approve", "setup:policy",
    "task:a:create", "task:a:plan", "task:a:approve", "task:a:develop",
    "task:a:apply", "task:a:report", "task:a:complete",
    "final:host-check",
  ]);
});

test("QA가 보완 필요로 끝나면 재개발을 한 번 더 누르고, 통과하면 끝낸다", async () => {
  const { api, calls } = fakeForge([
    { status: "failed", latestQaOutcome: "fail", summary: "최대 보완 횟수 도달 · QA 보완 필요" },
    { status: "succeeded", latestQaOutcome: "pass", summary: "AI QA 통과" },
  ]);

  await develop(ctxWith(api), "a", scenario.tasks[0], scenario);

  assert.equal(calls.filter((call) => call.path === "/forge/pipeline/start").length, 2);
});

test("AI가 질문만 남기면 보충 설명을 요구사항에 더하고 플랜부터 다시 하라고 알린다", async () => {
  const { api, calls } = fakeForge([
    { status: "failed", latestQaOutcome: null, summary: "AI가 코드 대신 확인 질문을 남김 · 답변·플랜 보완 필요", error: "질문?" },
  ]);
  const ctx = ctxWith(api);

  await assert.rejects(develop(ctx, "a", scenario.tasks[0], scenario), (error) => error instanceof GoBack && error.stepId === "task:a:plan");

  const saved = calls.find((call) => call.path === "/forge/requirements/save");
  assert.match(saved.body.text, /보충 설명:\n보충/);
  assert.equal(ctx.data.tasks.a.clarified, true);
});

test("보충 설명을 이미 썼는데도 질문이 오면 사람에게 넘긴다", async () => {
  const { api } = fakeForge([
    { status: "failed", summary: "AI가 코드 대신 확인 질문을 남김", error: "또 질문" },
  ]);
  const ctx = ctxWith(api);
  ctx.data.tasks.a.clarified = true;

  await assert.rejects(develop(ctx, "a", scenario.tasks[0], scenario), (error) => error instanceof StepFailure && error.kind === "human");
});
