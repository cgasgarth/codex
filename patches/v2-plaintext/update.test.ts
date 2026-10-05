import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { updateBackend } from "./update";

const roots: string[] = [];
const oldVersion = "codex-cli 1.0.0";
const newVersion = "codex-cli 1.1.0";
async function fixture() {
  const base = await mkdtemp(resolve(tmpdir(), "codex-patch-update-"));
  roots.push(base);
  await mkdir(resolve(base, "bin"));
  await writeFile(resolve(base, "bin/codex-patched"), "old backend");
  await writeFile(resolve(base, "version.txt"), oldVersion + "\n");
  const candidate = resolve(base, "candidate");
  await writeFile(candidate, "new backend");
  const steps = { build: async () => candidate, verify: async (_binary: string) => {}, currentVersion: async () => newVersion };
  const installed = async () => ({ binary: await readFile(resolve(base, "bin/codex-patched"), "utf8"), version: (await readFile(resolve(base, "version.txt"), "utf8")).trim() });
  return { base, candidate, steps, installed };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("a new backend replaces the old one only after verification passes", async () => {
  const f = await fixture();
  f.steps.verify = async candidate => {
    expect(candidate).toBe(f.candidate);
    expect(await f.installed()).toEqual({ binary: "old backend", version: oldVersion });
  };
  expect(await updateBackend(f.base, newVersion, f.steps)).toBe("ready");
  expect(await f.installed()).toEqual({ binary: "new backend", version: newVersion });
});

test("a failed live probe leaves the installed backend intact", async () => {
  const f = await fixture();
  f.steps.verify = async () => { throw new Error("Claude handoff failed"); };
  await expect(updateBackend(f.base, newVersion, f.steps)).rejects.toThrow("Claude handoff failed");
  expect(await f.installed()).toEqual({ binary: "old backend", version: oldVersion });
});

test("an invalid source patch cannot activate a candidate", async () => {
  const f = await fixture();
  f.steps.build = async () => { throw new Error("git apply failed"); };
  await expect(updateBackend(f.base, newVersion, f.steps)).rejects.toThrow("git apply failed");
  expect(await f.installed()).toEqual({ binary: "old backend", version: oldVersion });
});

test("simultaneous app launches share one update", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => entered = resolve);
  const releasePromise = new Promise<void>(resolve => release = resolve);
  f.steps.verify = async () => { entered(); await releasePromise; };
  const first = updateBackend(f.base, newVersion, f.steps);
  await enteredPromise;
  expect(await updateBackend(f.base, newVersion, f.steps)).toBe("updating");
  release();
  expect(await first).toBe("ready");
  expect(await f.installed()).toEqual({ binary: "new backend", version: newVersion });
});

test("disabling during verification prevents activation", async () => {
  const f = await fixture();
  f.steps.verify = async () => { await writeFile(resolve(f.base, "disabled"), ""); };
  expect(await updateBackend(f.base, newVersion, f.steps)).toBe("disabled");
  expect(await f.installed()).toEqual({ binary: "old backend", version: oldVersion });
});

test("a second app update during the build prevents version mismatch", async () => {
  const f = await fixture();
  f.steps.currentVersion = async () => "codex-cli 1.2.0";
  await expect(updateBackend(f.base, newVersion, f.steps)).rejects.toThrow("changed during the build");
  expect(await f.installed()).toEqual({ binary: "old backend", version: oldVersion });
});
