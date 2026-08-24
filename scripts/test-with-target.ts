import { spawn } from "node:child_process";
import { startTargetServer } from "../target-app/server.js";

const port = Number(process.env.TARGET_PORT ?? 4471);
const target = await startTargetServer(port);

try {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "tests/*.test.ts"], {
      stdio: "inherit",
      env: { ...process.env, TARGET_PORT: String(port) },
      shell: true,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await target.close();
}
