# tester-agent

[Forge](https://github.com/kms0539/forge-harness)를 **실제 사용자처럼 처음부터 끝까지** 써 보는 테스트 에이전트입니다.
막히면 멈추고, AI에게 Forge 수정을 맡기고, 검사를 통과하면 **직전 단계부터 다시** 진행합니다.
이렇게 Forge를 계속 써 보면서 고쳐 나가는 것이 목적입니다.

## 하는 일

시나리오(JSON) 하나를 Forge 사용 순서대로 진행합니다.

```
새 프로젝트(빈 저장소)
→ 기술 스택 결정: AI 플랜 → 승인 → 공통 정책 반영
→ 작업마다: 작업 저장 → AI 플랜 → 승인 → 원사이클(개발→검증→QA) → 원본 반영 → 커밋·push → 보고서 → 완료
→ 반영된 저장소를 이 PC에서 직접 확인 (예: npm install && npm test)
```

각 단계는 화면의 버튼과 같은 API를 같은 순서로 부르고, 끝난 뒤 Forge 상태가 기대대로인지 확인합니다.

- QA가 "보완 필요"로 끝나면 사람처럼 **재개발**을 한 번 더 누릅니다.
- 시나리오의 `clarification`(보충 설명)은 처음부터 요구사항에 함께 넣습니다. 그래도 AI가 코드 대신 **질문**만 남기면, 같은 보충 설명으로 **범위 안 답변**을 남기고 같은 플랜으로 바로 이어 개발합니다.
- 그래도 안 되면 그 단계에서 멈추고 보고서를 남깁니다.

## 막혔을 때 (`--fix`)

1. `runs/<실행>/failures/NN-단계.md`에 보고서를 씁니다. 실패 내용, 그때 Forge 상태 요약, Forge 서버 로그가 들어갑니다.
2. Claude Code(또는 Codex)에게 보고서를 주고 **forge-harness 수정**을 맡깁니다.
3. Forge의 `npm test`, 타입 검사, 린트를 모두 통과하면 **커밋**합니다. 통과하지 못하면 `git stash`로 빼 두고 멈춥니다.
4. Forge를 다시 시작하고, 직전 단계가 여전히 맞는지 확인한 뒤 막혔던 단계부터 이어 갑니다.

같은 단계를 2번 고쳐도 안 되면 사람에게 넘깁니다.
자동 수정은 **로컬 커밋만** 합니다. push는 사람이 확인한 뒤에 합니다.

### 실패 종류

| 종류 | 뜻 |
|---|---|
| `forge` | Forge가 기대와 다르게 동작함 (고칠 대상) |
| `quality` | AI 결과가 재시도 뒤에도 기준 미달 |
| `product` | 만든 결과물이 이 PC에서 안 됨 |
| `human` | 사람이 정해야 함 (AI 질문 등) |

AI는 `forge` 외의 경우에도 보고서를 보고, Forge 쪽에서 고칠 것(안내·규칙·검증)이 있을 때만 수정합니다.

## 실행

준비: [forge-harness](https://github.com/kms0539/forge-harness)를 옆 폴더(`../forge-harness`)에 두고 `npm install`, Docker 이미지 빌드까지 해 둡니다.

```bash
node bin/tester.mjs run scenarios/slug-kit.json --fix    # 새로 실행
node bin/tester.mjs resume <runId> --fix                 # 멈춘 곳부터 이어 하기
node bin/tester.mjs list                                 # 실행 기록
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--fix` | 끔 | 막히면 AI에게 Forge 수정을 맡김 |
| `--engine` | `claude` | 수정을 맡길 AI (`claude`, `codex`) |
| `--forge` | `../forge-harness` | Forge 저장소 위치 (`TESTER_FORGE_DIR`) |
| `--port` | `3291` | 테스트용 Forge API 포트 (`TESTER_FORGE_PORT`) |

테스트용 Forge는 평소 쓰는 Forge와 **다른 포트·다른 데이터 폴더**(`runs/<실행>/forge-data`)로 띄우므로 서로 섞이지 않습니다.
`Ctrl+C`로 끊어도 Forge를 정리하고 끝나며, `resume`으로 이어 갈 수 있습니다.
실행이 끝나면 `runs/<실행>/summary.md`에 결과·실패·자동 수정 내역과 단계별 시간이 남습니다.

## 시나리오

`scenarios/slug-kit.json`이 예시입니다.

| 항목 | 설명 |
|---|---|
| `name`, `goal` | Forge 프로젝트 이름·목표 |
| `ai` | 플랜·개발에 쓸 엔진과 모델 |
| `stack.language`, `stack.decision` | 기술 스택 결정 작업에서 공통 정책으로 반영할 내용 |
| `verify.command` | Forge 안 실행 검증 명령 (Docker, 이 PC와 같은 Node 버전) |
| `hostCheck` | 마지막에 이 PC에서 돌려 볼 명령 |
| `publish` | `true`면 실행 폴더의 로컬 원격(`remote.git`)을 origin으로 두고 '커밋하고 push'까지 시험 |
| `repository` | 이어서 개발할 기존 Git 저장소 URL. 실행 폴더로 clone하고, 시험 중 push는 실행 폴더의 원격으로만 나갑니다 |
| `tasks[]` | `key`, `title`, `requirement`, `clarification`(AI 질문에 대한 답), `dependsOn`(선행 작업 key 목록), `files`(AI에게 줄 기존 파일 경로) |
| `maxManualRework` | QA 보완 필요 시 재개발을 더 누를 횟수 (기본 1) |

## 파일

```
bin/tester.mjs        실행 진입점
src/steps.mjs         시나리오 → 단계 목록 (화면 동작과 같은 API 호출)
src/runner.mjs        단계 실행, 실패 기록, 고친 뒤 이어 하기
src/journal.mjs       실행 기록(runs/<실행>/journal.json)
src/improver.mjs      보고서 작성, AI에게 Forge 수정 맡기기, 검사·커밋
src/forge-server.mjs  테스트용 Forge 서버 시작·종료
src/forge-api.mjs     Forge API 호출
src/snapshot.mjs      보고서용 Forge 상태 요약
src/summary.mjs       실행 요약(summary.md)
```

```bash
npm test
```
