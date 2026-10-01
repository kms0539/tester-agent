// 실행 기록(journal.json).
// 끝난 단계와 단계 사이에 넘기는 값(프로젝트 ID 등)을 매번 저장해서, 중간에 끊겨도 같은 자리에서 이어 간다.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function openJournal(runDir, initial = {}) {
  await mkdir(runDir, { recursive: true });
  const file = join(runDir, "journal.json");

  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      status: "running",
      startedAt: new Date().toISOString(),
      done: [],
      data: {},
      failures: [],
      fixes: [],
      ...initial,
    };
  }

  async function save() {
    state.updatedAt = new Date().toISOString();
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, file);
  }

  return {
    runDir,
    get state() { return state; },
    get data() { return state.data; },

    isDone: (stepId) => state.done.includes(stepId),

    async markDone(stepId) {
      if (!state.done.includes(stepId)) state.done.push(stepId);
      await save();
    },

    // 이 단계와 그 뒤 단계를 '안 함'으로 되돌린다. 요구사항을 바꿔 플랜부터 다시 할 때처럼 쓴다.
    async rewindTo(stepId, steps) {
      const from = steps.findIndex((step) => step.id === stepId);
      const later = new Set(steps.slice(from).map((step) => step.id));
      state.done = state.done.filter((id) => !later.has(id));
      await save();
    },

    async recordFailure(failure) {
      state.failures.push({ ...failure, at: new Date().toISOString() });
      await save();
      return state.failures.length;
    },

    async recordFix(fix) {
      state.fixes.push({ ...fix, at: new Date().toISOString() });
      await save();
    },

    // 단계마다 실제로 걸린 시간을 더해 둔다. 실패 뒤 다시 한 시간도 포함하고, AI가 Forge를 고친 시간은 뺀다.
    async addTime(stepId, ms) {
      state.timings ??= {};
      state.timings[stepId] = (state.timings[stepId] ?? 0) + ms;
      await save();
    },

    fixCount: (stepId) => state.fixes.filter((fix) => fix.stepId === stepId).length,

    async finish(status, note = "") {
      state.status = status;
      state.note = note;
      state.finishedAt = new Date().toISOString();
      await save();
    },

    save,
  };
}
