// 실행이 끝나면 사람이 읽을 요약(summary.md)을 남긴다.

import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export async function writeSummary(journal, scenario) {
  const state = journal.state;
  const file = join(journal.runDir, "summary.md");
  const minutes = Math.round((Date.parse(state.finishedAt ?? state.updatedAt) - Date.parse(state.startedAt)) / 60_000);

  const failures = state.failures.map((item, index) => `| ${index + 1} | ${item.title} | ${item.kind} | ${oneLine(item.message)} |`);
  const fixes = state.fixes.map((item) => `| #${item.failure} | ${oneLine(item.summary)} | ${item.commit ?? ""} | ${item.report ? relative(journal.runDir, item.report) : ""} |`);

  const text = [
    `# ${scenario.name} 실행 요약`,
    "",
    `- 결과: **${label(state.status)}**${state.note ? ` — ${state.note}` : ""}`,
    `- 시작: ${state.startedAt} · 걸린 시간: 약 ${minutes}분`,
    `- 끝난 단계: ${state.done.length}개 · 실패: ${state.failures.length}번 · Forge 자동 수정: ${state.fixes.length}번`,
    "",
    "## 실패",
    "",
    failures.length ? ["| # | 단계 | 종류 | 내용 |", "|---|---|---|---|", ...failures].join("\n") : "없음",
    "",
    "## Forge 자동 수정 (로컬 커밋, push 전 검토 필요)",
    "",
    fixes.length ? ["| 실패 | 수정 | 커밋 | 보고서 |", "|---|---|---|---|", ...fixes].join("\n") : "없음",
    "",
    "## 끝난 단계",
    "",
    ...state.done.map((id) => `- ${id}`),
    "",
  ].join("\n");

  await writeFile(file, text);
  return file;
}

const label = (status) => ({ passed: "통과", stopped: "멈춤", interrupted: "중단", running: "진행 중" })[status] ?? status;
const oneLine = (text = "") => String(text).replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160);
