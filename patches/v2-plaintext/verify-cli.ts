import { mkdir, copyFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";

const base = resolve(import.meta.dir, "build/probes");
const binary = process.argv[2] ?? resolve(import.meta.dir, "bin/codex");
const run = Date.now();
const cases = [
  { name: "gpt-parent", model: "gpt-6.1-sol", children: ["claude-fable-5-1", "claude-opus-5-5", "gpt-6-luna"] },
  { name: "claude-parent", model: "claude-opus-5-5", children: ["gpt-6-luna"] },
];

const results = await Promise.allSettled(cases.map(async (test) => {
  const folder = resolve(base, `${test.name}-${run}`);
  const home = resolve(folder, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  await copyFile("/Users/cgas/.codex/auth.json", resolve(home, "auth.json"));
  await chmod(resolve(home, "auth.json"), 0o600);
  const catalog = await Bun.file("/Users/cgas/.codex/model-catalog.json").json();
  for (const model of catalog.models) model.multi_agent_version = "v2";
  await Bun.write(resolve(home, "catalog.json"), JSON.stringify(catalog, null, 2));
  await Bun.write(resolve(home, "config.toml"), `model_provider = "vibeproxy"
model_catalog_json = ${JSON.stringify(resolve(home, "catalog.json"))}
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[model_providers.vibeproxy]
name = "VibeProxy"
base_url = "http://127.0.0.1:8318/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true
stream_idle_timeout_ms = 120000
request_max_retries = 1
[features.multi_agent_v2]
enabled = true
tool_namespace = "agents"
hide_spawn_agent_metadata = false
expose_spawn_agent_model_overrides = true
non_code_mode_only = false
`);
  const children = test.children.map((model, index) => ({ model, task: `child_${index}`, path: resolve(folder, `child_${index}.json`) }));
  const prompt = `This is an authorized real V2 subagent test. Spawn exactly these children using model overrides and fork_turns="none": ${JSON.stringify(children)}.
For each child, give this readable task: use a shell tool to run bun to calculate 17+25 and write JSON {nonce:${JSON.stringify(nonce)},initial:42} to that child's specified absolute path. Send a message to /root containing the nonce and computed result, then finish with the nonce and result. Do not merely echo the expected value: run the command and write the file. Do not spawn extra agents.
Wait for all children to finish. For each child, call send_message with text "AUDIT ${nonce}", then followup_task with this new task: read your earlier JSON file, verify its nonce, run bun to calculate 8+9, add followup:17 and audit:"AUDIT ${nonce}" to the same file, send_message to /root with the follow-up result, and finish. Wait for all follow-ups. Report actual child models and results. Use the available agents namespace tools or functions code-mode tools. All work is restricted to ${folder}.`;
  await Bun.write(resolve(folder, "prompt.txt"), prompt);
  const child = Bun.spawn([binary, "exec", "--json", "--skip-git-repo-check", "-m", test.model, "-C", folder, prompt], {
    env: { ...process.env, CODEX_HOME: home, CODEX_V2_PLAINTEXT: "1" },
    stdout: Bun.file(resolve(folder, "events.jsonl")),
    stderr: Bun.file(resolve(folder, "stderr.log")),
    stdin: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 360000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const artifacts = await Promise.all(children.map(async (item) => {
    try {
      const data = await Bun.file(item.path).json();
      return { model: item.model, path: item.path, data, valid: data.nonce === nonce && data.initial === 42 && data.followup === 17 && data.audit === `AUDIT ${nonce}` };
    } catch (error) { return { model: item.model, error: String(error), valid: false }; }
  }));
  const result = { name: test.name, model: test.model, exitCode, artifacts, passed: exitCode === 0 && artifacts.every(item => item.valid) };
  await Bun.write(resolve(folder, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  return result;
}));
await Bun.write(resolve(base, `probe-results-${run}.json`), JSON.stringify(results, null, 2));
