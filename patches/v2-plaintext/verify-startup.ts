import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export async function verifyStartup(binary: string) {
  const home = await mkdtemp(resolve(tmpdir(), "codex-patch-startup-"));
  const child = Bun.spawn([binary, "-c", "features.multi_agent_v2.enabled=true", "-c", 'features.multi_agent_v2.tool_namespace="agents"', "app-server"], {
    env: { ...process.env, CODEX_HOME: home, CODEX_V2_PLAINTEXT: "1" }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  let timeout: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((accept, reject) => {
      timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("App-server startup timed out")); }, 15000);
      child.exited.then(() => reject(new Error("App-server exited before startup checks completed")));
      const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
      (async () => {
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (event.id !== 1 && event.id !== 2) continue;
            if (event.error) throw new Error(JSON.stringify(event.error));
            if (event.id === 1) {
              send({ method: "initialized" });
              send({ id: 2, method: "config/read", params: { includeLayers: false } });
            } else {
              const settings = event.result.config.features.multi_agent_v2;
              if (!settings.enabled || settings.tool_namespace !== "agents") throw new Error("V2 startup settings were not accepted");
              accept();
              return;
            }
          }
        }
      })().catch(reject);
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "plaintext_v2_startup", version: "1" }, capabilities: { experimentalApi: true } } });
    });
  } finally {
    clearTimeout(timeout!);
    child.stdin.end();
    child.kill("SIGTERM");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verifyStartup(process.argv[2] ?? resolve(import.meta.dir, "bin/codex-patched"));
  console.log("App-server startup passed; no model requests made.");
}
