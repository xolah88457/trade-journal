// Run with the bundled Node binary so SQLite keeps its build-time native ABI.
const path = require("node:path");
process.env.NODE_ENV = "production";
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "0";
process.env.NEXT_TELEMETRY_DISABLED = "1";
require(path.join(__dirname, "server", "apps", "web", "server.js"));
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.kill(process.pid, "SIGTERM");
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
