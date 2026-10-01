import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../src/journal.mjs";
import { GoBack, runSteps, StepFailure } from "../src/runner.mjs";

const quiet = () => {};

async function journalFor(t) {
  const dir = await mkdtemp(join(tmpdir(), "tester-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return openJournal(dir);
}

// 실행 순서를 기록하는 가짜 단계. state[id]가 true면 '이미 되어 있음'으로 본다.
function fakeSteps(ids, state, calls, behaviour = {}) {
  return ids.map((id) => ({
    id,
    title: id,
    async run() {
      calls.push(id);
      await behaviour[id]?.();
      state[id] = true;
    },
    check: async () => Boolean(state[id]),
  }));
}

test("모든 단계를 순서대로 실행하고, 이미 되어 있는 단계는 건너뛴다", async (t) => {
  const journal = await journalFor(t);
  const calls = [];
  const state = { b: true };

  const result = await runSteps({ steps: fakeSteps(["a", "b", "c"], state, calls), journal, ctx: {}, log: quiet });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["a", "c"]);
  assert.deepEqual(journal.state.done, ["a", "b", "c"]);
});

test("고치기가 없으면 실패를 기록하고 멈춘다", async (t) => {
  const journal = await journalFor(t);
  const steps = fakeSteps(["a", "b"], {}, [], {
    b: () => { throw new StepFailure("forge", "b가 깨짐"); },
  });

  const result = await runSteps({ steps, journal, ctx: {}, log: quiet });

  assert.equal(result.status, "stopped");
  assert.equal(journal.state.failures[0].stepId, "b");
  assert.equal(journal.state.failures[0].kind, "forge");
  assert.deepEqual(journal.state.done, ["a"]);
});

test("고친 뒤 직전 단계가 깨졌으면 그 단계부터, 아니면 실패한 단계부터 다시 한다", async (t) => {
  const journal = await journalFor(t);
  const calls = [];
  const state = {};
  let broken = true;
  const steps = fakeSteps(["a", "b", "c"], state, calls, {
    c: () => { if (broken) throw new StepFailure("forge", "c가 깨짐"); },
  });

  const result = await runSteps({
    steps,
    journal,
    ctx: {},
    log: quiet,
    // 고치면서 직전 단계(b)의 상태가 사라진 상황을 흉내 낸다.
    onFailure: async () => {
      broken = false;
      state.b = false;
      return { fixed: true, summary: "c 수정" };
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["a", "b", "c", "b", "c"]);
  assert.equal(journal.state.fixes.length, 1);
});

test("GoBack을 받으면 지정한 단계부터 다시 진행한다", async (t) => {
  const journal = await journalFor(t);
  const calls = [];
  const state = {};
  let asked = false;
  const steps = fakeSteps(["plan", "approve", "develop"], state, calls, {
    develop: () => {
      if (asked) return;
      asked = true;
      state.plan = false;
      state.approve = false;
      throw new GoBack("plan", "요구사항 보완");
    },
  });

  const result = await runSteps({ steps, journal, ctx: {}, log: quiet });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["plan", "approve", "develop", "plan", "approve", "develop"]);
});

test("같은 단계를 정해진 횟수만큼 고쳐도 실패하면 사람에게 넘긴다", async (t) => {
  const journal = await journalFor(t);
  let fixes = 0;
  const steps = fakeSteps(["a"], {}, [], {
    a: () => { throw new StepFailure("forge", "계속 깨짐"); },
  });

  const result = await runSteps({
    steps,
    journal,
    ctx: {},
    log: quiet,
    maxFixesPerStep: 2,
    onFailure: async () => ({ fixed: true, summary: `시도 ${++fixes}` }),
  });

  assert.equal(result.status, "stopped");
  assert.equal(fixes, 2);
  assert.match(result.note, /2번 고쳐도/);
});

test("이어 하기: 저장된 기록을 다시 열면 끝난 단계는 실행하지 않는다", async (t) => {
  const first = await journalFor(t);
  await first.markDone("a");
  first.data.projectId = "p1";
  await first.save();

  const reopened = await openJournal(first.runDir);
  const calls = [];
  const result = await runSteps({ steps: fakeSteps(["a", "b"], {}, calls), journal: reopened, ctx: {}, log: quiet });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["b"]);
  assert.equal(reopened.data.projectId, "p1");
});
