import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  assertToolSuccess,
  buildReleasePlan,
  classifyKeychainLookup,
  executeKeyprep,
  loadSparkleArtifactsModule,
  parseCliFlag,
  resolveSparkleBinary,
  runRelease,
  runSparkleTool,
  setRepoSecretViaStdin,
  verifyPrivateKeyMatchesPublic,
} from "./update-tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Synthetic in-memory Ed25519 fixtures (NO real Keychain / prod keygen)
// ---------------------------------------------------------------------------

function makeSyntheticKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = pkcs8.subarray(-32); // raw 32-byte seed
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicB64 = publicRaw.toString("base64");
  // Official generate_keys -x export format: base64 TEXT of the 32-byte seed
  const exportFileContent = Buffer.from(seed.toString("base64"), "utf8");
  return { seed, publicRaw, publicB64, exportFileContent };
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal fake child process for spawnImpl injection. */
function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  process.nextTick(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  });
  return child;
}

/**
 * Fake child whose stdin emits EPIPE when written (simulates gh/tool exiting early).
 * The 'error' is emitted on nextTick after write() and 'close' on setImmediate after,
 * so a missing stdin error listener would surface as an unhandled 'error' crash.
 */
function fakeChildStdinEpipe({ code = 1 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.write = () => {
    process.nextTick(() => child.stdin.emit("error", new Error("write EPIPE")));
    return true;
  };
  setImmediate(() => child.emit("close", code, null));
  return child;
}

// ---------------------------------------------------------------------------
// Async resolver + pin verification
// ---------------------------------------------------------------------------

test("resolver: async resolveOfficialTool from pinned electron-sparkle 0.2.0 only, no fallbacks", async () => {
  const calls = [];
  const fakeArtifacts = {
    resolveOfficialTool: async (opts) => {
      calls.push(opts);
      return `/pinned/bin/${opts.name}`;
    },
  };
  const p = await resolveSparkleBinary("sign_update", { artifacts: fakeArtifacts });
  assert.equal(p, "/pinned/bin/sign-update");
  assert.deepEqual(calls, [{ name: "sign-update", architecture: "arm64" }]);
  await assert.rejects(() => resolveSparkleBinary("rm-rf", { artifacts: fakeArtifacts }));
});

test("resolver: loadSparkleArtifactsModule verifies the 0.2.0 pin and requires resolveOfficialTool", () => {
  const tmp = makeTempDir("sparkle-pin-");
  try {
    const pkgDir = path.join(tmp, "electron-sparkle");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });

    // Wrong version -> rejected
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "electron-sparkle", version: "9.9.9" }),
    );
    assert.throws(
      () => loadSparkleArtifactsModule({ packageJsonPath: path.join(pkgDir, "package.json") }),
      /pinned to exactly 0\.2\.0/,
    );

    // Correct pin but missing artifacts module -> rejected
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "electron-sparkle", version: "0.2.0" }),
    );
    assert.throws(
      () => loadSparkleArtifactsModule({ packageJsonPath: path.join(pkgDir, "package.json") }),
      /artifacts-C_Z5iSIA\.cjs/,
    );

    // Correct pin + artifacts module exporting resolveOfficialTool -> loads
    fs.writeFileSync(
      path.join(pkgDir, "dist", "artifacts-C_Z5iSIA.cjs"),
      "exports.resolveOfficialTool = async () => '/stub/tool';\n",
    );
    const mod = loadSparkleArtifactsModule({ packageJsonPath: path.join(pkgDir, "package.json") });
    assert.equal(typeof mod.resolveOfficialTool, "function");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Key mismatch: private/public match via PKCS#8 + SPKI derivation
// ---------------------------------------------------------------------------

test("key match: official base64(seed) export verifies against the derived public key", () => {
  const { seed, publicRaw, publicB64, exportFileContent } = makeSyntheticKeypair();
  assert.equal(verifyPrivateKeyMatchesPublic(exportFileContent, publicB64), true);
  // Public key is the SPKI tail, NOT the seed prefix
  assert.equal(publicRaw.equals(seed), false);
  // Wrong configured public key -> mismatch
  const other = makeSyntheticKeypair();
  assert.equal(verifyPrivateKeyMatchesPublic(exportFileContent, other.publicB64), false);
  // Legacy 96-byte format (64-byte private || 32-byte public), base64 text
  const legacy = Buffer.concat([seed, publicRaw, publicRaw]);
  assert.equal(
    verifyPrivateKeyMatchesPublic(Buffer.from(legacy.toString("base64")), publicB64),
    true,
  );
  // Tampered legacy blob -> mismatch
  const tampered = Buffer.from(legacy);
  tampered[80] ^= 0xff;
  assert.equal(
    verifyPrivateKeyMatchesPublic(Buffer.from(tampered.toString("base64")), publicB64),
    false,
  );
  // Raw binary (non-base64) export is not the official format -> rejected
  assert.equal(verifyPrivateKeyMatchesPublic(seed, publicB64), false);
  // Garbage -> rejected
  assert.equal(verifyPrivateKeyMatchesPublic(Buffer.from("!!!not-base64!!!"), publicB64), false);
});

// ---------------------------------------------------------------------------
// Keychain lookup classification: missing vs access-denied/cancel
// ---------------------------------------------------------------------------

test("keychain lookup: distinguishes missing from access-denied/canceled (no rotation on denial)", () => {
  assert.deepEqual(classifyKeychainLookup({ code: 0, stdout: "AAAA", stderr: "" }), {
    status: "present",
    publicKey: "AAAA",
  });
  assert.equal(
    classifyKeychainLookup({ code: 1, stdout: "", stderr: "No existing signing key found!" })
      .status,
    "missing",
  );
  assert.equal(
    classifyKeychainLookup({
      code: 1,
      stdout: "",
      stderr: "Access denied. Can't check existing keys in the keychain.",
    }).status,
    "denied",
  );
  assert.equal(
    classifyKeychainLookup({
      code: 1,
      stdout: "",
      stderr: "User canceled the authorization request.",
    }).status,
    "denied",
  );
  assert.equal(
    classifyKeychainLookup({
      code: 1,
      stdout: "",
      stderr: "The operating system has blocked access to the Keychain.",
    }).status,
    "denied",
  );
});

// ---------------------------------------------------------------------------
// Fixed config: release plan derives feed/archive URL from validated config
// ---------------------------------------------------------------------------

test("release plan: feedUrl and archiveURL come from validated config, no undeclared default", () => {
  const source = fs.readFileSync(path.join(__dirname, "update-tools.mjs"), "utf8");
  assert.equal(source.includes("DEFAULT_FEED_URL"), false);

  const config = {
    provider: "sparkle",
    feedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    publicEdKey: makeSyntheticKeypair().publicB64,
    releaseTagPrefix: "electron-v",
    archiveUrlPattern:
      "https://github.com/xolah88457/trade-journal/releases/download/electron-v{version}/Sumi-{version}-macos-arm64.zip",
  };
  const plan = buildReleasePlan({ config, version: "0.2.0", distDir: "dist" });
  assert.equal(plan.feedUrl, config.feedUrl);
  assert.equal(
    plan.archiveURL,
    "https://github.com/xolah88457/trade-journal/releases/download/electron-v0.2.0/Sumi-0.2.0-macos-arm64.zip",
  );
  assert.equal(plan.zipName, "Sumi-0.2.0-macos-arm64.zip");
  assert.equal(
    plan.downloadUrlPrefix,
    "https://github.com/xolah88457/trade-journal/releases/download/electron-v0.2.0/",
  );
  assert.equal(plan.zipPath, path.join("dist", "Sumi-0.2.0-macos-arm64.zip"));

  // Invalid config -> rejected; non-ZIP pattern -> rejected; http feed override -> rejected
  assert.throws(() =>
    buildReleasePlan({ config: { ...config, publicEdKey: "" }, version: "0.2.0" }),
  );
  assert.throws(() =>
    buildReleasePlan({
      config: { ...config, archiveUrlPattern: "https://x.test/electron-v{version}/app.dmg" },
      version: "0.2.0",
    }),
  );
  assert.throws(() =>
    buildReleasePlan({
      config,
      version: "0.2.0",
      feedUrlOverride: "http://insecure.example.com/f.xml",
    }),
  );
});

// ---------------------------------------------------------------------------
// No secret leak: gh secret upload via STDIN with fixed argv; tool errors sanitized
// ---------------------------------------------------------------------------

test("gh secret upload: fixed argv with fixed repo, secret only via STDIN, never in args", async () => {
  const secret = Buffer.from("c3VwZXItc2VjcmV0LXNlZWQ=", "utf8");
  const seen = { argv: null, stdin: [] };
  const spawnImpl = (cmd, argv) => {
    seen.argv = { cmd, argv };
    const child = fakeChild({ code: 0 });
    child.stdin.on("data", (c) => seen.stdin.push(c));
    return child;
  };
  await setRepoSecretViaStdin({ repo: "xolah88457/trade-journal", secret, spawnImpl });
  assert.equal(seen.argv.cmd, "gh");
  assert.deepEqual(seen.argv.argv, [
    "secret",
    "set",
    "SPARKLE_PRIVATE_KEY",
    "--repo",
    "xolah88457/trade-journal",
  ]);
  assert.ok(!seen.argv.argv.includes(secret.toString("utf8")));
  assert.equal(Buffer.concat(seen.stdin).toString("utf8"), secret.toString("utf8"));

  // Non-zero exit -> sanitized rejection
  await assert.rejects(
    setRepoSecretViaStdin({
      repo: "xolah88457/trade-journal",
      secret,
      spawnImpl: () => fakeChild({ code: 1 }),
    }),
    /gh secret set failed/,
  );
});

test("tool errors: assertToolSuccess throws a constant message that never leaks captured stderr", async () => {
  const leak = "SEED_SECRET_abc123";
  const result = await runSparkleTool("/fake/tool", ["--ed-key-file", "-"], {
    spawnImpl: () => fakeChild({ code: 1, stderr: `boom ${leak}` }),
  });
  assert.equal(result.code, 1);
  assert.throws(
    () => assertToolSuccess(result, "Sanitized error: Failed to sign archive."),
    (err) => {
      assert.equal(err.message, "Sanitized error: Failed to sign archive.");
      assert.ok(!err.message.includes(leak));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// executeKeyprep with fully mocked keychain: persist-before-upload + upload retry,
// key mismatch halt, and access-denied no-rotation
// ---------------------------------------------------------------------------

function makeKeychainMock({ keypair, deny = false } = {}) {
  const calls = [];
  let generated = false;
  return {
    calls,
    runTool: async (bin, args) => {
      calls.push([...args]);
      if (args.includes("-p")) {
        if (deny) {
          return {
            code: 1,
            signal: null,
            stdout: "",
            stderr: "Access denied. Can't check existing keys in the keychain.",
          };
        }
        if (!generated) {
          return { code: 1, signal: null, stdout: "", stderr: "No existing signing key found!" };
        }
        return { code: 0, signal: null, stdout: keypair.publicB64, stderr: "" };
      }
      if (args.includes("-x")) {
        const file = args[args.indexOf("-x") + 1];
        fs.writeFileSync(file, keypair.exportFileContent, { mode: 0o600 });
        calls[calls.length - 1].push(file);
        return { code: 0, signal: null, stdout: "", stderr: "" };
      }
      generated = true; // generate_keys --account <account>
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

test("keyprep: public config persisted BEFORE gh upload, so a failed upload can be retried", async () => {
  const keypair = makeSyntheticKeypair();
  const tmp = makeTempDir("keyprep-retry-");
  const configPath = path.join(tmp, "update-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ provider: "sparkle" }, null, 2), "utf8");

  const keychain = makeKeychainMock({ keypair });
  const secretCalls = [];
  let failFirstUpload = true;
  const setSecret = async ({ repo, secret }) => {
    secretCalls.push({ repo, secret: Buffer.from(secret) });
    if (failFirstUpload) {
      failFirstUpload = false;
      throw new Error("Sanitized error: gh secret set failed.");
    }
  };
  const deps = {
    configPath,
    resolveTool: async () => "/fake/generate_keys",
    runTool: keychain.runTool,
    setSecret,
  };

  try {
    // First run: upload fails AFTER the public config was persisted
    await assert.rejects(executeKeyprep(deps), /gh secret set failed/);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.publicEdKey, keypair.publicB64); // persisted BEFORE upload -> retry-safe

    // Temp export file was zero-filled + removed in finally
    const exportCall = keychain.calls.find((c) => c.includes("-x"));
    const exportFile = exportCall[exportCall.indexOf("-x") + 1];
    assert.equal(fs.existsSync(exportFile), false);

    // Retry: succeeds, secret uploaded via the injected channel exactly once more
    const result = await executeKeyprep(deps);
    assert.equal(result.success, true);
    assert.equal(result.publicKey, keypair.publicB64);
    assert.equal(secretCalls.length, 2);
    assert.equal(secretCalls[1].repo, "xolah88457/trade-journal");
    // The uploaded secret is the official base64(seed) export and matches the public key
    assert.equal(verifyPrivateKeyMatchesPublic(secretCalls[1].secret, keypair.publicB64), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("keyprep: exported private key mismatch halts BEFORE any secret upload", async () => {
  const keypair = makeSyntheticKeypair();
  const other = makeSyntheticKeypair();
  const tmp = makeTempDir("keyprep-mismatch-");
  const configPath = path.join(tmp, "update-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ provider: "sparkle" }, null, 2), "utf8");

  // Keychain holds `other`'s key, but the -x export writes `keypair`'s seed (mismatch)
  const keychain = makeKeychainMock({ keypair: other });
  const originalRunTool = keychain.runTool;
  keychain.runTool = async (bin, args) => {
    if (args.includes("-x")) {
      const file = args[args.indexOf("-x") + 1];
      fs.writeFileSync(file, keypair.exportFileContent, { mode: 0o600 });
      keychain.calls.push([...args, file]);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
    return originalRunTool(bin, args);
  };

  let uploads = 0;
  try {
    await assert.rejects(
      executeKeyprep({
        configPath,
        resolveTool: async () => "/fake/generate_keys",
        runTool: keychain.runTool,
        setSecret: async () => {
          uploads++;
        },
      }),
      /does not match the public key/,
    );
    assert.equal(uploads, 0); // never uploaded
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("keyprep: access-denied lookup halts and never generates a new key (no rotation)", async () => {
  const keypair = makeSyntheticKeypair();
  const tmp = makeTempDir("keyprep-denied-");
  const configPath = path.join(tmp, "update-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ provider: "sparkle" }, null, 2), "utf8");

  const keychain = makeKeychainMock({ keypair, deny: true });
  try {
    await assert.rejects(
      executeKeyprep({
        configPath,
        resolveTool: async () => "/fake/generate_keys",
        runTool: keychain.runTool,
        setSecret: async () => {},
      }),
      /denied or the authorization request was canceled/,
    );
    // Only the -p lookup ran; no generate call (which would rotate the identity)
    assert.ok(keychain.calls.every((c) => c.includes("-p")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Release path (runRelease): secret/config match BEFORE sign; appcast read from
// the tool-produced file, never from stdout
// ---------------------------------------------------------------------------

function makeReleaseFixture() {
  const keypair = makeSyntheticKeypair();
  const tmp = makeTempDir("release-test-");
  const distDir = path.join(tmp, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const config = {
    provider: "sparkle",
    feedUrl: "https://github.com/xolah88457/trade-journal/releases/latest/download/appcast.xml",
    publicEdKey: keypair.publicB64,
    releaseTagPrefix: "electron-v",
    archiveUrlPattern:
      "https://github.com/xolah88457/trade-journal/releases/download/electron-v{version}/Sumi-{version}-macos-arm64.zip",
  };
  const configPath = path.join(tmp, "update-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  const zipName = "Sumi-0.2.0-macos-arm64.zip";
  fs.writeFileSync(path.join(distDir, zipName), Buffer.from("fake-zip-bytes"), "utf8");
  return {
    keypair,
    tmp,
    distDir,
    configPath,
    zipName,
    privateKey: keypair.exportFileContent.toString("utf8"),
  };
}

test("cli flags: parser accepts both --flag=value and --flag value", () => {
  const args = [
    "release",
    "--version=0.2.0",
    "--dist-dir",
    "out",
    "--feed-url=https://x.test/f.xml",
  ];
  assert.equal(parseCliFlag(args, "version"), "0.2.0");
  assert.equal(parseCliFlag(args, "dist-dir"), "out");
  assert.equal(parseCliFlag(args, "feed-url"), "https://x.test/f.xml");
  assert.equal(parseCliFlag(args, "missing"), null);
});

test("release: SPARKLE_PRIVATE_KEY mismatching config publicEdKey is rejected BEFORE any sign/key-use", async () => {
  const { tmp, configPath, privateKey } = makeReleaseFixture();
  const other = makeSyntheticKeypair(); // different key -> mismatch
  const toolCalls = [];
  try {
    await assert.rejects(
      runRelease({
        version: "0.2.0",
        distDir: path.join(tmp, "dist"),
        configPath,
        privateKey: other.exportFileContent.toString("utf8"), // wrong secret
        resolveTool: async (name) => {
          toolCalls.push(name);
          return `/fake/${name}`;
        },
        runTool: async () => {
          toolCalls.push("runTool");
          return { code: 0, signal: null, stdout: "", stderr: "" };
        },
      }),
      /does not match the publicEdKey/,
    );
    // No tool was ever resolved or executed — mismatch rejected before sign/key-use
    assert.deepEqual(toolCalls, []);
    assert.equal(fs.existsSync(path.join(tmp, "dist", "appcast.xml")), false);
    assert.ok(privateKey.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("release: publishes only the tool-produced appcast.xml (validated, signed), never stdout diagnostics", async () => {
  const { tmp, distDir, configPath, zipName, privateKey } = makeReleaseFixture();
  const calls = [];
  const producedAppcast = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
    "  <channel>",
    `    <item><enclosure url="https://example.test/electron-v0.2.0/${zipName}" sparkle:edSignature="c2ln" sparkle:version="0.2.0" sparkle:shortVersionString="0.2.0" type="application/octet-stream"/></item>`,
    "  </channel>",
    "</rss>",
  ].join("\n");
  const runTool = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], input: opts && opts.input != null ? "[stdin]" : null });
    if (bin.includes("sign-update")) {
      assert.deepEqual(args.slice(0, 2), ["--ed-key-file", "-"]);
      return { code: 0, signal: null, stdout: "Updated signature inside archive", stderr: "" };
    }
    // generate_appcast: writes appcast.xml into the release dir (last arg); stdout is diagnostics
    const releaseDir = args[args.length - 1];
    fs.writeFileSync(path.join(releaseDir, "appcast.xml"), producedAppcast, "utf8");
    return {
      code: 0,
      signal: null,
      stdout: "diagnostics: 1 update processed — THIS IS NOT XML",
      stderr: "",
    };
  };
  try {
    const result = await runRelease({
      version: "0.2.0",
      distDir,
      configPath,
      privateKey,
      resolveTool: async (name) => `/fake/${name}`,
      runTool,
    });
    assert.equal(result.appcastPath, path.join(distDir, "appcast.xml"));
    const published = fs.readFileSync(result.appcastPath, "utf8");
    // Published feed is the tool-produced file (RSS + edSignature + zip + version), NOT stdout
    assert.equal(published, producedAppcast);
    assert.ok(!published.includes("NOT XML"));
    assert.ok(published.includes("sparkle:edSignature"));
    // Private key went via stdin only, never argv
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.input === "[stdin]"));
    assert.ok(calls.every((c) => !c.args.includes(privateKey)));
    // Temp release dir cleaned up (only ZIP + appcast.xml were inside, now removed)
    const leftovers = fs.readdirSync(distDir);
    assert.deepEqual(leftovers.sort(), ["Sumi-0.2.0-macos-arm64.zip", "appcast.xml"].sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("release: missing tool-produced appcast.xml fails sanitized and publishes nothing", async () => {
  const { tmp, distDir, configPath, privateKey } = makeReleaseFixture();
  try {
    await assert.rejects(
      runRelease({
        version: "0.2.0",
        distDir,
        configPath,
        privateKey,
        resolveTool: async (name) => `/fake/${name}`,
        runTool: async () => ({ code: 0, signal: null, stdout: "no file written", stderr: "" }),
      }),
      /did not produce appcast\.xml/,
    );
    assert.equal(fs.existsSync(path.join(distDir, "appcast.xml")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// stdin EPIPE / early-exit: handled BEFORE write, sanitized reject, late close safe
// ---------------------------------------------------------------------------

test("gh secret upload: stdin EPIPE on early gh exit rejects sanitized (no crash, no secret leak, late close safe)", async () => {
  const secret = Buffer.from("c3VwZXItc2VjcmV0LXNlZWQ=", "utf8");
  await assert.rejects(
    setRepoSecretViaStdin({
      repo: "xolah88457/trade-journal",
      secret,
      spawnImpl: () => fakeChildStdinEpipe({ code: 1 }),
    }),
    (err) => {
      assert.match(err.message, /^Sanitized error:/);
      assert.ok(!err.message.includes(secret.toString("utf8")));
      assert.ok(!err.message.includes("EPIPE"));
      return true;
    },
  );
});

test("runSparkleTool: stdin EPIPE while piping the key rejects sanitized; sync spawn throw is sanitized too", async () => {
  const secretInput = "c3VwZXItc2VjcmV0LXNlZWQ=";
  await assert.rejects(
    runSparkleTool("/fake/sign_update", ["--ed-key-file", "-", "app.zip"], {
      input: secretInput,
      spawnImpl: () => fakeChildStdinEpipe({ code: 1 }),
    }),
    (err) => {
      assert.match(err.message, /^Sanitized error:/);
      assert.ok(!err.message.includes(secretInput));
      return true;
    },
  );
  // Synchronous spawnImpl throw -> sanitized rejection, raw path never leaked
  await assert.rejects(
    runSparkleTool("/secret/local/path/generate_keys", [], {
      spawnImpl: () => {
        throw new Error("spawn /secret/local/path/generate_keys ENOENT");
      },
    }),
    (err) => {
      assert.equal(err.message, "Sanitized error: Failed to execute Sparkle tool.");
      assert.ok(!err.message.includes("/secret/local/path"));
      return true;
    },
  );
});

test("keyprep: stdin EPIPE during gh upload still runs finally — temp key file removed, secret buffer zeroed", async () => {
  const keypair = makeSyntheticKeypair();
  const tmp = makeTempDir("keyprep-epipe-");
  const configPath = path.join(tmp, "update-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ provider: "sparkle" }, null, 2), "utf8");

  const keychain = makeKeychainMock({ keypair });
  let exportFile = null;
  const runTool = async (bin, args) => {
    const res = await keychain.runTool(bin, args);
    if (args.includes("-x")) exportFile = args[args.indexOf("-x") + 1];
    return res;
  };
  let capturedSecret = null;
  // Use the REAL setRepoSecretViaStdin with an EPIPE-failing gh child
  const setSecret = (o) => {
    capturedSecret = o.secret;
    return setRepoSecretViaStdin({ ...o, spawnImpl: () => fakeChildStdinEpipe({ code: 1 }) });
  };

  try {
    await assert.rejects(
      executeKeyprep({
        configPath,
        resolveTool: async () => "/fake/generate_keys",
        runTool,
        setSecret,
      }),
      /Sanitized error: Failed to pipe secret to gh CLI via STDIN\./,
    );
    assert.ok(exportFile, "export step ran");
    assert.equal(fs.existsSync(exportFile), false, "temp key file removed by finally");
    assert.equal(
      fs.existsSync(path.dirname(exportFile)),
      false,
      "0700 temp dir removed by finally",
    );
    assert.ok(
      capturedSecret && capturedSecret.length > 0 && capturedSecret.every((b) => b === 0),
      "secret buffer zero-filled by finally",
    );
    // Public config was still persisted BEFORE the upload attempt (retry-safe)
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).publicEdKey, keypair.publicB64);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
