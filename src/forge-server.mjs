// 테스트용 Forge API 서버를 띄우고 끈다.
// 사용자가 평소 쓰는 Forge(3201, work/forge)와 섞이지 않게 포트와 데이터 폴더를 따로 준다.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const KEEP_LOG_LINES = 200;

export function createForgeServer({ forgeDir, port, dataRoot, repositoryRoot, logFile }) {
  let child = null;
  const recent = [];

  function remember(chunk) {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > KEEP_LOG_LINES) recent.shift();
    }
  }

  async function start() {
    if (child) return;

    const out = createWriteStream(logFile, { flags: "a" });
    out.write(`\n===== Forge 시작 ${new Date().toISOString()} =====\n`);

    child = spawn(process.execPath, ["--experimental-wasm-imported-strings", join(forgeDir, "scripts/interface/server.mjs")], {
      cwd: forgeDir,
      env: {
        ...process.env,
        FORGE_API_PORT: String(port),
        FORGE_DATA_ROOT: dataRoot,
        FORGE_REPOSITORY_ROOT: repositoryRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        out.write(chunk);
        remember(chunk);
      });
    }
    child.once("exit", () => {
      out.end();
      child = null;
    });

    await waitUntilReady();
  }

  // Forge는 포트를 잡은 뒤 데이터 폴더 소유권을 확인한다. 둘 다 끝나야 쓸 수 있다.
  async function waitUntilReady(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = "응답 없음";

    while (Date.now() < deadline) {
      if (!child) throw new Error(`Forge 서버가 시작 중에 종료됐습니다.\n${recent.slice(-20).join("\n")}`);
      try {
        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        if (health.forge?.ready) return health;
        last = health.forge?.message ?? "Forge 준비 중";
      } catch {
        // 아직 포트를 열지 않았다.
      }
      await sleep(300);
    }
    throw new Error(`Forge 서버가 ${timeoutMs / 1000}초 안에 준비되지 않았습니다: ${last}`);
  }

  // SIGTERM 한 번이면 Forge가 진행 중인 작업을 정리하고 소유권을 반납한다.
  async function stop() {
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(70_000)]);
  }

  async function restart() {
    await stop();
    await start();
  }

  return {
    start,
    stop,
    restart,
    recentLogs: () => recent.slice(),
    get running() { return Boolean(child); },
  };
}
