import { mkdir, copyFile, chmod, symlink, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const base = resolve(import.meta.dir);
const appCli = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
async function capture(args: string[], cwd = base): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.slice(-2000)}`);
  return stdout.trim();
}
const versionLine = await capture([appCli, "--version"]);
const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(versionLine);
if (!match) throw new Error(`Unrecognized app backend version: ${versionLine}`);
const version = match[1];
const dir = resolve(base, "build", version);
await mkdir(dir, { recursive: true });
const archive = resolve(dir, "upstream.tar.gz");
const source = resolve(dir, "source");
if (await Bun.file(resolve(source, "codex-rs/Cargo.toml")).exists()) {
  throw new Error(`Build directory already exists: ${dir}. Use a new clean build directory.`);
}
const response = await fetch(`https://api.github.com/repos/openai/codex/tarball/rust-v${version}`);
if (!response.ok) throw new Error(`Official source download failed: HTTP ${response.status}`);
await Bun.write(archive, response);
await mkdir(source);
await capture(["tar", "-xzf", archive, "-C", source, "--strip-components=1"]);
await capture(["git", "apply", "--check", resolve(base, "plaintext.patch")], source);
await capture(["git", "apply", resolve(base, "plaintext.patch")], source);
const log = Bun.file(resolve(base, "build.log"));
const child = Bun.spawn(["cargo", "build", "--profile", "dev-small", "-p", "codex-cli", "--bin", "codex"], {
  cwd: resolve(source, "codex-rs"),
  env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" },
  stdout: log, stderr: log,
});
console.log(`Building official Codex ${version} plus the two-file patch; log: ${log.name}`);
if (await child.exited !== 0) throw new Error(`Build failed; see ${log.name}`);
await mkdir(resolve(base, "bin"), { recursive: true });
await copyFile(resolve(source, "codex-rs/target/dev-small/codex"), resolve(base, "bin/codex-patched"));
await chmod(resolve(base, "bin/codex-patched"), 0o755);
const codeHost = resolve(base, "bin/codex-code-mode-host");
try { await unlink(codeHost); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
await symlink("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host", codeHost);
await Bun.write(resolve(base, "version.txt"), versionLine + "\n");
console.log(`Built ${versionLine}. Run mixed-model probes before restarting the app on this backend.`);
