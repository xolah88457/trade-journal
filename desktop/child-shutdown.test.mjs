import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("graceful child shutdown sends SIGTERM and bounds with SIGKILL", async () => {
  // Spawn a child process that signals readiness then traps SIGTERM
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  // Wait until child has attached its SIGTERM handler
  await new Promise((resolve) => {
    child.stdout.once("data", () => resolve());
  });

  let isStopping = false;
  let childRef = child;

  async function stopChild(timeoutMs = 500) {
    if (!childRef || isStopping) return "already_stopped";
    isStopping = true;
    const proc = childRef;
    childRef = null;

    if (proc.exitCode !== null || proc.killed) return "already_exited";

    await new Promise((resolve) => {
      let killTimer = null;
      const onExit = () => {
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      proc.once("exit", onExit);

      try {
        proc.kill("SIGTERM");
      } catch {
        if (killTimer) clearTimeout(killTimer);
        return resolve();
      }

      killTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null) {
            proc.kill("SIGKILL");
          }
        } catch {}
        resolve();
      }, timeoutMs);
    });

    return "stopped";
  }

  assert.equal(child.exitCode, null);

  const start = Date.now();
  const result1 = await stopChild(300);
  const elapsed = Date.now() - start;

  assert.equal(result1, "stopped");
  // Killed by SIGKILL within bounded timeout (~300ms)
  assert.ok(elapsed >= 250 && elapsed < 2000);

  // Calling stop again guarded against double shutdown
  const result2 = await stopChild(300);
  assert.equal(result2, "already_stopped");
});

test("late child exit detection when not shutting down", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(42);"], {
    stdio: "ignore",
  });

  let unexpectedExitCode = null;
  const isStopping = false;

  child.once("exit", (code) => {
    if (!isStopping) {
      unexpectedExitCode = code;
    }
  });

  await once(child, "exit");
  assert.equal(unexpectedExitCode, 42);
});
