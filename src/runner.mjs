// 시나리오 단계를 순서대로 실행한다.
//
// 단계 = { id, title, run(ctx), check?(ctx) }
//   run   : 사용자가 화면에서 하는 동작을 API로 한다.
//   check : 그 동작 뒤 Forge 상태가 기대대로인지 본다. 이미 맞으면 run을 건너뛴다(이어하기용).
//
// 실패하면 기록하고 onFailure(고치기)를 부른다. 고쳤으면 직전 단계를 다시 확인한 뒤 실패한 단계부터 이어 간다.

/** 단계 실패. kind로 누구 문제인지 나눈다. */
export class StepFailure extends Error {
  /**
   * @param {"forge"|"quality"|"product"|"human"} kind
   *   forge   : Forge가 기대와 다르게 동작했다(고칠 대상)
   *   quality : AI 결과가 기준을 못 넘었다(재시도·시나리오 보완 대상)
   *   product : 만든 결과물이 사용자 환경에서 안 된다
   *   human   : 사람이 정해야 한다(질문·권한 등)
   */
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

/** 앞 단계로 되돌아가 다시 진행하라는 신호. 요구사항을 보완해 플랜부터 다시 할 때 쓴다. */
export class GoBack extends Error {
  constructor(stepId, reason) {
    super(reason);
    this.stepId = stepId;
  }
}

export async function runSteps({ steps, journal, ctx, onFailure = null, maxFixesPerStep = 2, log = console.log }) {
  let index = 0;

  while (index < steps.length) {
    const step = steps[index];

    if (journal.isDone(step.id)) {
      index++;
      continue;
    }

    const started = Date.now();
    try {
      if (step.check && await quietCheck(step, ctx)) {
        log(`✓ ${step.title} (이미 되어 있음)`);
      } else {
        log(`▶ ${step.title}`);
        await step.run(ctx);
        if (step.check && !(await step.check(ctx))) {
          throw new StepFailure("forge", `‘${step.title}’ 뒤 Forge 상태가 기대와 다릅니다.`);
        }
      }
      await journal.addTime(step.id, Date.now() - started);
      await journal.markDone(step.id);
      index++;
    } catch (error) {
      await journal.addTime(step.id, Date.now() - started);
      if (error instanceof GoBack) {
        log(`↩ ${error.message} → ${error.stepId}부터 다시`);
        await journal.rewindTo(error.stepId, steps);
        index = steps.findIndex((item) => item.id === error.stepId);
        continue;
      }

      const failure = describeFailure(step, error);
      const number = await journal.recordFailure(failure);
      log(`✗ ${step.title} 실패 [${failure.kind}] ${failure.message}`);

      if (!onFailure) return stop(journal, `실패 #${number}: 고치기를 끈 상태라 멈춥니다.`);
      // 사람이 정할 일(AI 질문, 사용량 한도 등)은 Forge를 고쳐도 풀리지 않는다.
      if (failure.kind === "human") return stop(journal, `실패 #${number}: 사람이 확인해야 합니다 — ${failure.message}`);
      if (journal.fixCount(step.id) >= maxFixesPerStep) {
        return stop(journal, `실패 #${number}: 같은 단계를 ${maxFixesPerStep}번 고쳐도 통과하지 못했습니다. 사람이 확인해야 합니다.`);
      }

      const fix = await onFailure(failure, number);
      if (!fix?.fixed) return stop(journal, `실패 #${number}: ${fix?.reason ?? "고치지 못했습니다."}`);

      await journal.recordFix({ stepId: step.id, failure: number, ...fix });
      log(`🔧 고침: ${fix.summary ?? ""}`);

      // 고친 뒤에는 바로 앞 단계가 여전히 맞는지 먼저 본다. 아니면 그 단계부터 다시 한다.
      const previous = steps[index - 1];
      if (previous?.check && !(await quietCheck(previous, ctx))) {
        log(`↩ 직전 단계 ‘${previous.title}’부터 다시`);
        await journal.rewindTo(previous.id, steps);
        index--;
      }
    }
  }

  await journal.finish("passed");
  log("■ 시나리오 완료");
  return { status: "passed" };
}

async function quietCheck(step, ctx) {
  try {
    return Boolean(await step.check(ctx));
  } catch {
    return false;
  }
}

function describeFailure(step, error) {
  return {
    stepId: step.id,
    title: step.title,
    kind: error instanceof StepFailure ? error.kind : "forge",
    message: error.message,
    code: error.code ?? null,
    details: error.details ?? error.data ?? null,
    stack: error instanceof StepFailure ? null : error.stack?.split("\n").slice(0, 6).join("\n"),
  };
}

async function stop(journal, note) {
  await journal.finish("stopped", note);
  return { status: "stopped", note };
}
