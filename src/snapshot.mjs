// 실패 보고서에 넣을 Forge 상태 요약. 전체 기록은 너무 길어서 판단에 필요한 것만 남긴다.

export async function summarizeProject(api, projectId) {
  if (!projectId) return { note: "아직 프로젝트를 만들기 전입니다." };

  const { project, commit } = await api.post("/forge/project", { projectId });
  return {
    commit,
    name: project.name,
    activeBasis: project.bases?.at(-1) && {
      number: project.bases.at(-1).number,
      language: project.bases.at(-1).language ?? null,
      repositories: project.bases.at(-1).repositories,
    },
    tasks: project.tasks.map(summarizeTask),
  };
}

function summarizeTask(task) {
  const plan = task.plans?.find((item) => item.id === task.currentPlanId);
  return {
    title: task.title,
    status: task.status,
    kind: task.kind ?? null,
    plan: plan ? `P${plan.number}${task.approvedPlanId === plan.id ? " 승인" : " 미승인"}` : "없음",
    currentCheckpointId: task.currentCheckpointId ?? null,
    runs: (task.runs ?? []).slice(-6).map((run) => ({
      purpose: run.purpose,
      status: run.status,
      adopted: Boolean(run.adoptedAt),
      discarded: Boolean(run.discardedAt),
      error: run.error ?? null,
      result: run.result?.slice(0, 600) ?? null,
    })),
    lastQa: task.qaRecords?.at(-1) && {
      outcome: task.qaRecords.at(-1).outcome,
      text: task.qaRecords.at(-1).text.slice(0, 2000),
    },
    verifications: (task.verifications ?? []).slice(-3).map((item) => ({
      command: item.command,
      exitCode: item.exitCode,
      output: item.output?.slice(-1500),
    })),
    applications: (task.applications ?? []).map((item) => item.status),
  };
}
