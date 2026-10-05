import { mkdir, copyFile, chmod, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const base = resolve(import.meta.dir, "build/probes");
const dir = resolve(base, `app-server-${Date.now()}`);
const home = resolve(dir, "home");
await mkdir(home, { recursive: true, mode: 0o700 });
const runs = (await readdir(base)).filter(name => /^gpt-parent-\d+$/.test(name)).sort();
if (!runs.length) throw new Error("Run verify-cli.ts first.");
const sourceHome = resolve(base, runs.at(-1)!, "home");
await copyFile(resolve(sourceHome, "config.toml"), resolve(home, "config.toml"));
await copyFile(resolve(sourceHome, "auth.json"), resolve(home, "auth.json"));
await chmod(resolve(home, "auth.json"), 0o600);
const nonce = crypto.randomUUID();
const artifact = resolve(dir, "grandchild.json");
const log = Bun.file(resolve(dir, "events.jsonl")).writer();
const processHandle = Bun.spawn([process.argv[2] ?? resolve(import.meta.dir, "bin/codex"), "-c", "features.code_mode_host=true", "app-server"], {
  env: { ...process.env, CODEX_HOME: home, CODEX_V2_PLAINTEXT: "1" },
  stdin: "pipe", stdout: "pipe", stderr: Bun.file(resolve(dir, "stderr.log")),
});
let id = 0;
const requests = new Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>();
let rootId = "";
let completedResolve: (value: any) => void;
const completed = new Promise<any>(resolve => completedResolve = resolve);
const timeout = setTimeout(() => { processHandle.kill("SIGTERM"); completedResolve({ status: "timeout" }); }, 360000);
async function request(method: string, params: any) {
  const nextId = ++id;
  const result = new Promise<any>((resolve, reject) => requests.set(nextId, { resolve, reject }));
  processHandle.stdin.write(JSON.stringify({ id: nextId, method, params }) + "\n");
  await processHandle.stdin.flush();
  return result;
}
const reader = (async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const bytes of processHandle.stdout) {
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      log.write(line + "\n");
      const event = JSON.parse(line);
      if (requests.has(event.id)) {
        const waiter = requests.get(event.id)!; requests.delete(event.id);
        event.error ? waiter.reject(event.error) : waiter.resolve(event.result);
      }
      if (event.method === "turn/completed" && event.params.threadId === rootId) completedResolve(event.params.turn);
      if (event.id != null && event.method) {
        processHandle.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: "Unexpected request in isolated test" } }) + "\n");
      }
    }
  }
  for (const waiter of requests.values()) waiter.reject(new Error("Backend exited before responding"));
  requests.clear();
  completedResolve({ status: "backendExited" });
})();
try {
  await request("initialize", { clientInfo: { name: "v2_plaintext_probe", title: "V2 plaintext backend test", version: "0.160.0" }, capabilities: { experimentalApi: true } });
  processHandle.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const thread = await request("thread/start", { model: "gpt-6.1-sol", modelProvider: "vibeproxy", cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
  rootId = thread.thread.id;
  const text = `Authorized V2 nested subagent test. Spawn exactly one claude-opus-5-5 child named opus using fork_turns="none". Give it this task: Spawn exactly one gpt-6-luna grandchild named luna with fork_turns="none". The Luna grandchild must use a shell tool to run bun to compute 19+23 and write JSON {nonce:${JSON.stringify(nonce)},computed:42} to ${artifact}, send_message to its Opus parent reporting the result, and finish. Opus must wait for Luna, read and verify the file, then send_message to /root with the result and finish. You, the GPT root, must wait for Opus and read and verify the file. Do not write the artifact yourself. All work stays in ${dir}. This is explicit authorization for the two spawns only.`;
  await request("turn/start", { threadId: rootId, input: [{ type: "text", text, textElements: [] }] });
  const turn = await completed;
  let data;
  try { data = await Bun.file(artifact).json(); } catch {}
  const result = { rootId, dir, turnStatus: turn.status, artifact, data, passed: turn.status === "completed" && data?.nonce === nonce && data?.computed === 42 };
  await Bun.write(resolve(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  processHandle.stdin.end();
  await processHandle.exited;
  await reader;
  await log.end();
}
