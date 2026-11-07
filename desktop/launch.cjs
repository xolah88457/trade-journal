// Run with the bundled Node binary so SQLite keeps its build-time native ABI.
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "production";
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "0";
process.env.NEXT_TELEMETRY_DISABLED = "1";

const isTestMode = process.env.SUMI_TEST_MODE === "1";
const serverPath =
  isTestMode && process.env.SUMI_SERVER_PATH
    ? process.env.SUMI_SERVER_PATH
    : path.join(__dirname, "server", "apps", "web", "server.js");
if (fs.existsSync(serverPath)) {
  require(serverPath);
} else {
  try {
    require(serverPath);
  } catch (err) {
    if (!isTestMode) {
      throw err;
    }
  }
}

let isShuttingDown = false;
function dispatchShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearInterval(timer);
  clearTimeout(deadline);
  clearInterval(orphanTimer);

  // If Next.js has registered a SIGTERM cleanup listener, dispatch SIGTERM
  // so its asynchronous server/database cleanup runs naturally before exit.
  if (process.listenerCount("SIGTERM") > 0) {
    try {
      process.emit("SIGTERM");
    } catch {
      process.exit(0);
    }
    // Bounded watchdog fallback in case the server's SIGTERM handler hangs
    const fallbackTimer = setTimeout(() => {
      process.exit(0);
    }, 5000);
    fallbackTimer.unref();
  } else {
    process.exit(0);
  }
}

// 1. Parent-owned IPC channel messages (portable across Windows & Unix)
if (typeof process.on === "function") {
  process.on("message", (msg) => {
    if (
      msg === "sumi:shutdown" ||
      msg === "shutdown" ||
      (typeof msg === "object" &&
        msg !== null &&
        (msg.type === "sumi:shutdown" || msg.type === "shutdown"))
    ) {
      dispatchShutdown();
    }
  });

  // Automatically triggers on IPC disconnect if parent terminates abruptly
  process.on("disconnect", () => {
    dispatchShutdown();
  });

  // Note: We intentionally DO NOT register an immediate-exit SIGTERM/SIGINT
  // handler here. Normal POSIX signals must be received and handled by Next's
  // own async cleanup handler registered in start-server.js.
}

// 2. Orphan detection timer
const parent = process.ppid;
const orphanTimer = setInterval(() => {
  // On Unix, ppid changes when parent terminates
  if (process.ppid !== parent) {
    dispatchShutdown();
    return;
  }

  // On Windows, ppid never changes after parent termination; check if parent PID is still alive
  if (process.platform === "win32" && parent) {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if (e.code === "ESRCH") {
        dispatchShutdown();
      }
    }
  }
}, 2000).unref();

const deadline = setTimeout(() => {
  console.error("Sumi's local server did not become ready within 60 seconds.");
  process.exit(1);
}, 60_000);
let checking = false;
const timer = setInterval(async () => {
  const port = Number(process.env.PORT);
  if (!port || checking) return;
  checking = true;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(origin, {
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    if (response.status < 500) {
      clearInterval(timer);
      clearTimeout(deadline);
      console.log(`SUMI_READY ${origin}`);
    }
  } catch {
    // The socket can be listening before Next finishes preparing its handlers.
  } finally {
    checking = false;
  }
}, 200);
