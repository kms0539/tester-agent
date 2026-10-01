// 막힌 단계를 보고서로 남기고, AI(Claude Code·Codex)에게 Forge 수정을 맡긴다.
// 수정은 Forge 테스트·타입 검사·린트를 모두 통과해야 커밋한다. 통과하지 못하면 git stash로 빼 두고 멈춘다.

import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIX_TIMEOUT = 30 * 60_000;

const CLAUDE_TOOLS = [
  "Read", "Edit", "Write", "Grep", "Glob",
  "Bash(npm test)", "Bash(npm test:*)", "Bash(node --test:*)", "Bash(node --experimental-wasm-imported-strings --test:*)",
  "Bash(node -e:*)", "Bash(node --input-type=module:*)",
  "Bash(npx tsc:*)", "Bash(npx eslint:*)", "Bash(git diff:*)", "Bash(git status)",
].join(",");

export function createImprover({ forgeDir, engine = "claude", runDir, server, snapshot, log = console.log }) {
  const git = (...args) => execFileAsync("git", args, { cwd: forgeDir, maxBuffer: 16 * 1024 * 1024 });

  return async function fix(failure, number) {
    const dirty = (await git("status", "--porcelain")).stdout.trim();
    if (dirty) return { fixed: false, reason: "Forge 저장소에 커밋하지 않은 변경이 있어 자동 수정을 하지 않습니다. 먼저 정리해주세요." };

    const reportFile = join(runDir, "failures", `${String(number).padStart(2, "0")}-${failure.stepId.replaceAll(":", "_")}.md`);
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, await report(failure, { snapshot, server }));
    log(`  보고서: ${reportFile}`);

    log(`  ${engine}에게 Forge 수정을 맡깁니다(최대 ${FIX_TIMEOUT / 60_000}분)…`);
    const answer = await askAgent(engine, prompt(reportFile, join(runDir, "forge-data")), forgeDir);
    await writeFile(reportFile.replace(/\.md$/, `.${engine}.log`), answer.output);

    const changed = (await git("status", "--porcelain")).stdout.trim();
    if (!changed) {
      const reason = answer.output.match(/NO_FORGE_CHANGE:\s*(.+)/)?.[1] ?? "AI가 Forge를 바꾸지 않았습니다.";
      return { fixed: false, reason: `Forge 수정 없음 — ${reason}` };
    }

    const checks = await verifyForge(forgeDir);
    if (!checks.ok) {
      await git("stash", "push", "--include-untracked", "-m", `tester-agent 거절된 수정 #${number} ${failure.stepId}`);
      return { fixed: false, reason: `AI 수정이 Forge 검사를 통과하지 못해 git stash로 빼 두었습니다.\n${checks.output}` };
    }

    const summary = answer.output.match(/FIXED:\s*(.+)/)?.[1]?.trim() ?? `${failure.title} 문제 수정`;
    await git("add", "-A");
    await git("commit", "-m", commitMessage(summary, failure, number, reportFile));
    const commit = (await git("rev-parse", "--short", "HEAD")).stdout.trim();

    log("  Forge를 다시 시작합니다…");
    await server.restart();
    return { fixed: true, summary, commit, report: reportFile };
  };
}

// 제목은 한 줄로 짧게, 자세한 내용은 본문에 둔다.
function commitMessage(summary, failure, number, reportFile) {
  const title = summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
  return [
    `fix: ${title}`,
    "",
    summary,
    "",
    `tester-agent가 '${failure.title}' 단계에서 발견한 문제 (실패 #${number}, ${failure.kind})`,
    `보고서: ${reportFile}`,
    "",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  ].join("\n");
}

// ─── AI 실행 ────────────────────────────────────────────────

function askAgent(engine, text, cwd) {
  const bin = (name) => process.env[`TESTER_${name.toUpperCase()}_BIN`] ?? join(dirname(process.execPath), name);
  const [command, args] = engine === "codex"
    ? [bin("codex"), ["exec", "--full-auto", "-C", cwd, text]]
    : [bin("claude"), ["-p", text, "--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_TOOLS]];

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    const timer = setTimeout(() => child.kill("SIGTERM"), FIX_TIMEOUT);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n실행 실패: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function prompt(reportFile, dataDir) {
  return `너는 Forge(요구사항→플랜→AI 개발→QA→반영을 관리하는 로컬 도구) 저장소를 고치는 개발자다.
자동 테스트 에이전트(tester-agent)가 Forge를 실제 사용자처럼 쓰다가 한 단계에서 막혔다.
보고서를 먼저 읽어라: ${reportFile}

할 일
1. 원인을 찾는다. 추측하지 말고 실제로 실패한 데이터를 확인한다.
   테스트용 Forge 데이터: ${dataDir} (AI 실행의 원본 입력·결과는 .runs/<runId>/input.json, result.txt)
   고친 코드에 그 실제 데이터를 넣어 이번에는 통과하는지 직접 확인한다. 확인하지 못했으면 고치지 않는다.
2. Forge 쪽 문제(동작 오류, 잘못된 안내·검증, AI 지시 규칙의 모순, 상태 처리 누락)면 필요한 만큼만 고치고, 그 상황을 잡는 테스트를 추가한다.
3. 마치기 전에 npm test, npx tsc --noEmit -p ., npx eslint . 를 실행해 모두 통과시킨다.

Forge 구조에서 알아 둘 것
- 기준 규칙(basis.rules, FORGE_GENERAL_RULES)은 기준 저장 때 스냅샷으로 고정된다. 고쳐도 이미 만든 프로젝트에는 닿지 않는다.
- QA_INSTRUCTIONS, GENERAL_DEVELOPMENT_INSTRUCTIONS 같은 AI 지시문은 실행할 때마다 코드에서 읽으므로 바로 반영된다.
- 플랜·승인·체크포인트를 저장 시점에 고정하는 설계는 Forge의 원칙이다. 이 원칙을 바꾸지 말고, 원칙 안에서 가장 좁은 곳을 고친다.

규칙
- 이 저장소만 고친다. tester-agent와 테스트용 데이터는 건드리지 않는다.
- 사람이 읽기 쉬운 코드로 쓴다. 긴 한 줄을 만들지 말고 의미 단위로 줄을 나눈다. 주석은 짧게 '왜'만 쓴다.
- 커밋·push는 하지 않는다. 검사를 통과하면 tester-agent가 커밋한다.

마지막 줄
- 고쳤으면: FIXED: <바꾼 내용, 50자 이내 한 줄>
- Forge 문제가 아니면(AI 결과가 우연히 나쁨, 시나리오가 모호함 등) 코드를 바꾸지 말고: NO_FORGE_CHANGE: <이유>`;
}

// ─── 검사 ───────────────────────────────────────────────────

async function verifyForge(forgeDir) {
  const commands = [
    ["npm", ["test"]],
    ["npx", ["tsc", "--noEmit", "-p", "."]],
    ["npx", ["eslint", "."]],
  ];
  for (const [command, args] of commands) {
    try {
      await execFileAsync(command, args, { cwd: forgeDir, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n").filter((line) => /not ok|error|fail/i.test(line)).slice(0, 30).join("\n");
      return { ok: false, output: `${command} ${args.join(" ")} 실패\n${output}` };
    }
  }
  return { ok: true };
}

// ─── 보고서 ─────────────────────────────────────────────────

async function report(failure, { snapshot, server }) {
  const state = await snapshot().catch((error) => ({ error: error.message }));
  return `# 막힌 단계: ${failure.title}

- 단계 ID: \`${failure.stepId}\`
- 종류: **${failure.kind}** (forge=Forge 동작 문제, quality=AI 결과가 기준 미달, product=결과물이 이 PC에서 안 됨, human=사람 결정 필요)
- 오류 코드: ${failure.code ?? "없음"}

## 메시지

${failure.message}

## 세부 정보

\`\`\`json
${JSON.stringify(failure.details, null, 2)?.slice(0, 12000) ?? "없음"}
\`\`\`
${failure.stack ? `\n## 스택\n\n\`\`\`\n${failure.stack}\n\`\`\`\n` : ""}
## 그때 Forge 상태(요약)

\`\`\`json
${JSON.stringify(state, null, 2).slice(0, 20000)}
\`\`\`

## Forge 서버 최근 로그

\`\`\`
${server.recentLogs().slice(-80).join("\n")}
\`\`\`
`;
}
