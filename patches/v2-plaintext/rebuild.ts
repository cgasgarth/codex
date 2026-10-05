import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { updateBackend } from "./update";
import { verifyStartup } from "./verify-startup";

const base = resolve(import.meta.dir);
const appCli = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (process.argv.includes("--background")) {
  const log = openSync(resolve(base, "update.log"), "a", 0o600);
  const child = spawn(process.execPath, [import.meta.filename, "--if-needed"], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  process.exit(0);
}

async function capture(args: string[], cwd = base): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.slice(-2000)}`);
  return stdout.trim();
}
async function runLogged(args: string[], cwd: string, path: string) {
  const log = openSync(path, "w", 0o600);
  try {
    const child = Bun.spawn(args, { cwd, env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }, stdout: log, stderr: log });
    if (await child.exited !== 0) throw new Error(`${args[0]} failed; see ${path}`);
  } finally { closeSync(log); }
}
const versionLine = await capture([appCli, "--version"]);
const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(versionLine);
if (!match) throw new Error(`Unrecognized app backend version: ${versionLine}`);
const result = await updateBackend(base, versionLine, {
  currentVersion: () => capture([appCli, "--version"]),
  build: async () => {
    const dir = await mkdtemp(resolve(base, "build", `${match[1]}-`));
    const archive = resolve(dir, "upstream.tar.gz");
    const source = resolve(dir, "source");
    const response = await fetch(`https://api.github.com/repos/openai/codex/tarball/rust-v${match[1]}`);
    if (!response.ok) throw new Error(`Official source download failed: HTTP ${response.status}`);
    await Bun.write(archive, response);
    await mkdir(source);
    await capture(["tar", "-xzf", archive, "-C", source, "--strip-components=1"]);
    await capture(["git", "init", "-q"], source);
    await capture(["git", "apply", "--check", resolve(base, "plaintext.patch")], source);
    await capture(["git", "apply", resolve(base, "plaintext.patch")], source);
    console.error(`Building plaintext V2 for ${versionLine}.`);
    await runLogged(["cargo", "build", "--profile", "dev-small", "-p", "codex-cli", "--bin", "codex"], resolve(source, "codex-rs"), resolve(base, "build.log"));
    const candidate = resolve(source, "codex-rs/target/dev-small/codex");
    await symlink("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host", resolve(source, "codex-rs/target/dev-small/codex-code-mode-host"));
    return candidate;
  },
  verify: async candidate => {
    if (await capture([candidate, "--version"]) !== versionLine) throw new Error("Built backend version does not match the app");
    console.error("Checking app-server startup; no model requests.");
    await verifyStartup(candidate);
  },
});
console.error(`Plaintext V2 backend: ${result}. A ready update is used on the next app launch.`);
