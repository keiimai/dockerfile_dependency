import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAptIndex, inspectApt } from "../dist/apt-resolver.mjs";
import { makeDockerfile, pythonAptPackages, rVersions, selectBase, selectPythonBase } from "../dist/dockerfile.mjs";
import { wheelCandidate } from "../dist/python-packaging.mjs";
import catalog from "../dist/runtime-catalog.mjs";
import { TARGETS } from "../dist/targets.mjs";

test("uses a separate official index and fixed images for each OS", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(await readFile(url));
  try {
    const [noble, resolute] = await Promise.all(
      ["noble", "resolute"].map((release) => loadAptIndex(release, catalog[release].snapshot)),
    );
    assert.equal(noble.snapshot.suites[0], "noble");
    assert.equal(resolute.snapshot.suites[0], "resolute");
    assert(rVersions("noble").includes("4.5.3"));
    assert(rVersions("resolute").includes("4.6.2"));
    assert.equal(selectBase("4.6.2", "noble").status, "conflict");
    assert.equal(selectBase("4.5.3", "resolute").status, "conflict");
    for (const [release, index] of [["noble", noble], ["resolute", resolute]]) {
      const rVersion = rVersions(release).at(-1);
      const patch = catalog[release].python;
      for (const version of rVersions(release)) {
        const base = selectBase(version, release);
        assert.equal(base.status, "ok");
        assert.match(base.arm64Manifest, /^sha256:[a-f0-9]{64}$/);
      }
      const target = TARGETS[release];
      const bootstrap = pythonAptPackages(release);
      const apt = inspectApt([], [], index, bootstrap);
      const base = selectPythonBase(patch, index, release, apt);
      assert.equal(base.status, "ok");
      assert.equal(apt.plan.status, "ok");
      assert.equal(base.pythonVersion, patch);
      assert.equal(base.image, target.image);
      assert.match(index.real.get("libc6")[0].version, new RegExp("^2\\." + target.glibc + "[-+]"));
      const report = {base: selectBase(rVersion, release), apt, r: {ready: true, order: []}, requested: ["stats"]};
      const docker = makeDockerfile(report);
      assert(docker.includes('test "$ID:$VERSION_ID" = ubuntu:' + target.version));
      assert(docker.includes("/ " + release + " main"));
      assert.equal(makeDockerfile({...report, apt: {...apt, snapshot: (release === "noble" ? resolute : noble).snapshot}}), "");
    }
    await assert.rejects(loadAptIndex("noble", "20990101T000000Z"), /日時が一致しません/);
  } finally {
    globalThis.fetch = original;
  }
});

test("matches the manylinux glibc ceiling to the selected OS", () => {
  const filename = "demo-1.0-cp314-cp314-manylinux_2_43_aarch64.whl";
  const file = {filename, url:"https://files.pythonhosted.org/packages/f/" + filename, yanked:false, hashes:{sha256:"a".repeat(64)}};
  assert(wheelCandidate(file, "demo", "3.14.4", TARGETS.resolute.glibc));
  assert.equal(wheelCandidate(file, "demo", "3.14.4", TARGETS.noble.glibc), null);
});
