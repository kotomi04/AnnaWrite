import { spawn } from "node:child_process";

const apps = [
  {
    name: "anna-write-mvp",
    url: "http://localhost:5173/",
    args: ["--filter", "@anna-apps/anna-write-mvp", "dev"],
  },
  {
    name: "finder",
    url: "http://localhost:5180/",
    args: ["--filter", "@anna-apps/finder", "dev", "--", "--port", "5180"],
  },
  {
    name: "visual-brand",
    url: "http://localhost:5181/",
    args: ["--filter", "@anna-apps/visual-brand", "dev", "--", "--port", "5181"],
  },
  {
    name: "anna-visual-brand-mvp",
    url: "http://localhost:5182/",
    args: ["--filter", "@anna-apps/anna-visual-brand-mvp", "dev", "--", "--port", "5182"],
  },
];

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = new Map();
let stopping = false;

console.log("Starting Anna apps:");
for (const app of apps) console.log(`  ${app.name.padEnd(22)} ${app.url}`);
console.log("Press Ctrl+C to stop all apps.\n");

for (const app of apps) {
  const child = spawn(pnpm, app.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.set(app.name, child);

  child.on("exit", (code, signal) => {
    children.delete(app.name);
    if (stopping) return;
    if (code === 0 || signal) return;
    console.error(`\n${app.name} exited with code ${code}. Stopping the remaining apps.`);
    stopAll();
    process.exitCode = code ?? 1;
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    console.log("\nStopping Anna apps...");
    stopAll(signal);
  });
}

function stopAll(signal = "SIGTERM") {
  stopping = true;
  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}
