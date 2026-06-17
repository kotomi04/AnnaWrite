import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cli = join(root, "node_modules", "@anna-ai", "cli", "dist", "cli.js");
const cliDist = join(root, "node_modules", "@anna-ai", "cli", "dist");

const candidates = [
  ...["39", "310", "311", "312", "313"].map((version) =>
    join(os.homedir(), "AppData", "Roaming", "Python", `Python${version}`, "Scripts"),
  ),
  join(os.homedir(), ".cargo", "bin"),
  join(os.homedir(), ".local", "bin"),
];

const extraPath = candidates.filter(existsSync).join(process.platform === "win32" ? ";" : ":");
const env = {
  ...process.env,
  PATH: extraPath ? `${extraPath}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` : process.env.PATH,
};

patchWindowsBridgeCommand();
patchWindowsDoctorKeyMode();

const args = [cli, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function patchWindowsBridgeCommand() {
  if (process.platform !== "win32" || !existsSync(cliDist)) return;
  const bridgeDist = findBridgeDist();
  if (!bridgeDist) return;

  const body = readFileSync(bridgeDist, "utf8");

  const runtime = join(root, "scripts", "anna-bridge-windows.py").replaceAll("\\", "/");
  const marker = "const version = this.opts.runtimeVersion ?? PINNED_RUNTIME_VERSION;";
  const previousPatch =
    /\n\t\tif \(process\.platform === "win32"\) return \[\n\t\t\t"uv",\n\t\t\t"run",\n\t\t\t"--with",\n\t\t\t`anna-app-runtime-local==\$\{version\}`,\n\t\t\t"python",\n\t\t\t"[^"]*anna-bridge-windows\.py"\n\t\t\];/;
  const unpatched = body.replace(previousPatch, "");
  if (!unpatched.includes(marker)) return;

  const replacement = `${marker}
\t\tif (process.platform === "win32") return [
\t\t\t"uv",
\t\t\t"run",
\t\t\t"--with",
\t\t\t\`anna-app-runtime-local==\${version}\`,
\t\t\t"python",
\t\t\t"${runtime}"
\t\t];`;

  const next = unpatched.replace(marker, replacement);
  if (next !== body) writeFileSync(bridgeDist, next);
}

function findBridgeDist() {
  return readdirSync(cliDist)
    .filter((name) => /^bridge-.*\.js$/.test(name))
    .map((name) => join(cliDist, name))
    .find((candidate) => {
      const body = readFileSync(candidate, "utf8");
      return body.includes("class PythonBridge") && body.includes("PINNED_RUNTIME_VERSION");
    });
}

function patchWindowsDoctorKeyMode() {
  if (process.platform !== "win32" || !existsSync(cliDist)) return;
  const doctorDist = readdirSync(cliDist)
    .filter((name) => /^doctor-.*\.js$/.test(name))
    .map((name) => join(cliDist, name))
    .find((candidate) => readFileSync(candidate, "utf8").includes("expected 0600"));
  if (!doctorDist) return;

  const body = readFileSync(doctorDist, "utf8");
  const marker = "if (mode === 384)";
  const replacement = 'if (process.platform === "win32" || mode === 384)';
  if (body.includes(replacement) || !body.includes(marker)) return;
  writeFileSync(doctorDist, body.replace(marker, replacement));
}
