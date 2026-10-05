import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type UpdateSteps = {
  build: () => Promise<string>;
  verify: (binary: string) => Promise<void>;
  currentVersion: () => Promise<string>;
};

export async function updateBackend(base: string, version: string, steps: UpdateSteps) {
  const disabled = resolve(base, "disabled");
  const binary = resolve(base, "bin/codex-patched");
  const stamp = resolve(base, "version.txt");
  if (existsSync(disabled)) return "disabled";
  if (existsSync(binary) && existsSync(stamp) && (await readFile(stamp, "utf8")).trim() === version) return "current";

  const lock = resolve(base, "build/update.lock");
  await mkdir(resolve(base, "build"), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    let owner: number;
    try { owner = Number(await readFile(resolve(lock, "pid"), "utf8")); } catch { return "updating"; }
    if (!Number.isInteger(owner) || owner <= 0) return "updating";
    try { process.kill(owner, 0); return "updating"; } catch (error: any) { if (error.code !== "ESRCH") throw error; }
    await rm(lock, { recursive: true });
    return updateBackend(base, version, steps);
  }
  await writeFile(resolve(lock, "pid"), String(process.pid));
  const state = (status: string, error?: string) => writeFile(resolve(base, "update-state.json"), JSON.stringify({ version, status, error, time: new Date().toISOString() }, null, 2) + "\n");
  try {
    await state("building");
    const candidate = await steps.build();
    if (existsSync(disabled)) return "disabled";
    await state("testing");
    await steps.verify(candidate);
    if (existsSync(disabled)) return "disabled";
    if (await steps.currentVersion() !== version) throw new Error("The app backend changed during the build. Retry on the next launch.");
    await mkdir(resolve(base, "bin"), { recursive: true });
    await copyFile(candidate, binary + ".next");
    await rename(binary + ".next", binary);
    await writeFile(stamp + ".next", version + "\n");
    await rename(stamp + ".next", stamp);
    await state("ready");
    return "ready";
  } catch (error) {
    await state("failed", String(error));
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
