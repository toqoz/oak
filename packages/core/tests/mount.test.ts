import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  addMount,
  listMountStatus,
  loadMountConfig,
  mountDoctor,
} from "../src/mount.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-mount-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function makeVault(): Promise<string> {
  const vault = resolve(scratch, "vault");
  await mkdir(vault, { recursive: true });
  return vault;
}

async function makeTarget(name: string): Promise<string> {
  const dir = resolve(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "README.md"), "# external\n", "utf8");
  return dir;
}

describe("addMount", () => {
  it("creates a symlink under _external/<id> and writes the config", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    const entry = await addMount(vault, { id: "codebase", target });

    expect(entry.id).toBe("codebase");
    expect(entry.linkPath).toBe("_external/codebase");
    expect(entry.targetPath).toBe(target);
    expect(entry.mode).toBe("readonly");
    expect(entry.publishable).toBe(false);

    const cfgRaw = await readFile(
      resolve(vault, ".oak/mounts.local.yml"),
      "utf8",
    );
    expect(cfgRaw).toContain("codebase:");
    expect(cfgRaw).toContain(`targetPath: ${target}`);

    const status = (await listMountStatus(vault))[0]!;
    expect(status.linkExists).toBe(true);
    expect(status.targetExists).toBe(true);
  });

  it("rejects invalid mount ids", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await expect(
      addMount(vault, { id: "bad id with spaces", target }),
    ).rejects.toThrow(/Invalid mount id/);
  });

  it("refuses to overwrite an existing _external/<id>", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await mkdir(resolve(vault, "_external"), { recursive: true });
    await symlink("/tmp/whatever", resolve(vault, "_external/codebase"));
    await expect(
      addMount(vault, { id: "codebase", target }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses duplicate ids in the config", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await addMount(vault, { id: "codebase", target });
    const target2 = await makeTarget("repo2");
    await expect(
      addMount(vault, { id: "codebase", target: target2 }),
    ).rejects.toThrow(/already configured|already exists/);
  });

  it("loadMountConfig reads back the persisted entry", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await addMount(vault, { id: "x", target });
    const cfg = await loadMountConfig(vault);
    expect(cfg.mounts).toHaveLength(1);
    expect(cfg.mounts[0]!.id).toBe("x");
    expect(cfg.mounts[0]!.targetPath).toBe(target);
  });
});

describe("mountDoctor", () => {
  it("reports no issues for a healthy mount", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await addMount(vault, { id: "codebase", target });
    const issues = await mountDoctor(vault);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reports broken-mount-target when the target disappears", async () => {
    const vault = await makeVault();
    const target = await makeTarget("repo");
    await addMount(vault, { id: "codebase", target });
    await rm(target, { recursive: true });
    const issues = await mountDoctor(vault);
    expect(issues.some((i) => i.code === "broken-mount-target")).toBe(true);
  });
});
