import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import catalog from "../dist/runtime-catalog.mjs";
import { loadAptIndex } from "../dist/apt-resolver.mjs";
import { dockerfileBlockers, dockerfileHashes, makeDockerfile, pythonBuildPackages, selectPythonBase, PYTHON_APT } from "../dist/dockerfile.mjs";
import { normalizePythonName, pythonEnvironment, readRequirement, wheelCandidate } from "../dist/python-packaging.mjs";
import { inspectPythonTarget, pythonVersionChoices } from "../dist/python-investigation.mjs";
import { inspectPython, PYPI } from "../dist/python-resolver.mjs";

const target = "3.12.3";
const wheelHost = "https://files.pythonhosted.org/packages/ab/cd/";
const hash = (text) => createHash("sha256").update(text).digest("hex");

function release(name, version, {tags = "py3-none-any", deps = [], requires = ">=3.10", yanked = false, external = []} = {}) {
  const filename = name.replace(/-/g, "_") + "-" + version + "-" + tags + ".whl";
  const url = wheelHost + filename;
  const metadata = [
    "Metadata-Version: 2.3", "Name: " + name, "Version: " + version, "Requires-Python: " + requires,
    ...deps.map((value) => "Requires-Dist: " + value),
    ...external.map((value) => "Requires-External: " + value), "", "",
  ].join("\n");
  return {file: {filename, url, hashes: {sha256: hash(filename)}, "core-metadata": {sha256: hash(metadata)},
    "requires-python": requires, yanked}, metadata};
}

async function withPyPiFixture(catalog, investigate) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith(PYPI)) {
      const key = decodeURIComponent(url.slice(PYPI.length, -1));
      const items = catalog[key];
      if (!items) return new Response("", {status: 404});
      return Response.json({name: key, files: items.map((item) => item.file)});
    }
    for (const rows of Object.values(catalog)) {
      const release = rows.find(({file}) => file.url + ".metadata" === url);
      if (release) return new Response(release.metadata);
    }
    throw new Error("Unexpected fetch " + url);
  };
  try {
    return await investigate();
  } finally {
    globalThis.fetch = previous;
  }
}

function fixture(catalog, names, pythonVersion = target) {
  return withPyPiFixture(catalog, () => inspectPython(names, pythonVersion, () => {}));
}

const pythonTarget = (version, index) => ({
  requested: ["sample"], version, ubuntuRequested: [], release: "noble", index, progress() {},
});

test("generates a pinned source-build Dockerfile for other Python series and exact patches", async () => {
  const index = await loadBundledIndex();
  const distributions = {
    sample: [release("sample", "1.0", {
      tags: "cp313-cp313-manylinux_2_39_aarch64", requires: ">=3.13",
      deps: ['old-patch; python_full_version < "3.13.1"', 'new-patch; python_full_version >= "3.13.1"'],
    })],
    "old-patch": [release("old-patch", "1.0")],
    "new-patch": [release("new-patch", "1.0")],
  };
  const recent = catalog.pythonSeries["3.13"];
  const choices = pythonVersionChoices("noble");
  assert(choices.sourceVersions.length > 0);
  assert(choices.sourceVersions.every((version) => catalog.pythonSources[catalog.pythonSeries[version]]));
  for (const [version, effective, dependency] of [["3.13", recent, "new-patch"], ["3.13.0", "3.13.0", "old-patch"]]) {
    const result = await withPyPiFixture(distributions, () => inspectPythonTarget(pythonTarget(version, index)));
    const report = {...result, language: "python", requested: ["sample"]};
    assert.equal(result.pythonVersion, effective);
    assert.equal(result.python.environment.python_full_version, effective);
    assert.equal(result.python.ready, true);
    assert.deepEqual(result.python.nodes.map(({name}) => name), ["sample", dependency]);
    assert.equal(Boolean(result.pythonVersionNote), version === "3.13");
    assert.equal(result.pythonVersionSource, version === "3.13" ? "https://www.python.org/downloads/source/" : null);
    assert.equal(result.base.runtimeMethod, "source");
    assert.equal(result.apt.plan.status, "ok");
    assert.deepEqual(result.apt.pins.map(({name}) => name), pythonBuildPackages);
    assert.deepEqual(dockerfileBlockers(report), []);
    const dockerfile = makeDockerfile(report);
    const hashes = dockerfileHashes(report);
    assert.equal(hashes.pythonSource.sha256, catalog.pythonSources[effective]);
    assert(dockerfile.includes(hashes.pythonSource.url));
    assert(dockerfile.includes(hashes.pythonSource.sha256));
    assert.match(dockerfile, /sha256sum --check -/);
    assert.match(dockerfile, /\/opt\/cpython\/bin\/python3 -m venv/);
    assert(!dockerfile.includes("'python3-venv="));
    assert.equal(makeDockerfile({...report, base: {...report.base,
      pythonSource: {...report.base.pythonSource, sha256: "f".repeat(64)}}}), "");
    assert.equal(makeDockerfile({...report, apt: {...result.apt, pins: result.apt.pins.slice(1)}}), "");
    for (const [, shell] of dockerfile.matchAll(/^RUN <<'SH'\n(.*?)^SH$/gms)) {
      assert.equal(spawnSync("/bin/sh", ["-n"], {input: shell}).status, 0);
    }
  }
});

test("investigates a patch with no official source hash without generating a Dockerfile", async () => {
  const index = await loadBundledIndex();
  const minor = catalog.noble.python.split(".").slice(0, 2).join(".");
  const version = minor + ".999";
  const result = await withPyPiFixture({sample: [release("sample", "1.0", {requires: "==" + version})]},
    () => inspectPythonTarget(pythonTarget(version, index)));
  assert.equal(result.python.ready, true);
  assert.equal(result.pythonVersion, version);
  assert.equal(result.base.status, "pending");
  const report = {...result, language: "python"};
  assert.match(dockerfileBlockers(report)[0], /公式ソースの SHA-256 を確認できません/);
  assert.equal(makeDockerfile(report), "");
});

test("can investigate PyPI while the Ubuntu index is unavailable", async () => {
  const version = catalog.noble.python;
  const result = await withPyPiFixture({sample: [release("sample", "1.0")]},
    () => inspectPythonTarget(pythonTarget(version, undefined)));
  assert.equal(result.python.ready, true);
  assert.equal(result.pythonVersion, version);
  assert.equal(result.apt, null);
  assert.match(dockerfileBlockers({...result, language: "python"})[0], /APT 索引を取得できない/);
});

test("normalizes Python names and evaluates the target's markers and extras", () => {
  assert.equal(normalizePythonName("MarkUp_Safe"), "markup-safe");
  const env = pythonEnvironment(target);
  assert.equal(readRequirement('colorama; sys_platform == "win32"', env, []), null);
  assert.equal(readRequirement('p; python_version < "3.12" or (platform_machine == "aarch64" and python_full_version == "3.12.3")', env, []).name, "p");
  assert.equal(readRequirement('P; extra == "docs"', env, []), null);
  assert.equal(readRequirement('P[html] ~= 1.2; extra == "docs"', env, ["docs"]).condition, "~= 1.2");
  assert.throws(() => readRequirement('p; platform_release == "6.8"', env, []), /判定できません/);
});

test("selects stable wheels for CPython 3.12 and Ubuntu 24.04 ARM64", () => {
  const candidates = [
    ["cp312-cp312-manylinux_2_39_aarch64", true],
    ["cp311-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64", true],
    ["py3-none-any", true],
    ["cp313-cp313-manylinux_2_39_aarch64", false],
    ["cp312-cp312-manylinux_2_40_aarch64", false],
    ["cp312-cp312-manylinux_2_16_aarch64", false],
    ["cp312-cp312-manylinux_2_34_x86_64", false],
    ["cp312-cp312-musllinux_1_2_aarch64", false],
  ];
  for (const [tags, allowed] of candidates) {
    assert.equal(Boolean(wheelCandidate(release("demo", "1.0", {tags}).file, "demo", target)), allowed, tags);
  }
  assert.equal(wheelCandidate(release("demo", "1.0", {yanked: true}).file, "demo", target), null);
  assert.equal(wheelCandidate(release("demo", "2.0rc1").file, "demo", target), null);
  assert.equal(wheelCandidate(release("demo", "1.0", {requires: ">=3.13"}).file, "demo", target), null);
});

test("downloads per-wheel metadata, follows extras, and tries an older compatible version", async () => {
  const result = await fixture({
    first: [release("first", "2.0", {deps:["shared>=2"]}), release("first", "1.0", {deps:["shared[doc]<2"]})],
    second: [release("second", "1.0", {deps:["shared<2"]})],
    shared: [release("shared", "2.0"), release("shared", "1.0", {deps:['optional; extra == "doc"','windows; os_name == "nt"']})],
    optional: [release("optional", "1.0", {external:["libxml2"]})],
  }, ["first", "second"]);
  assert(result.ready);
  assert.deepEqual(result.nodes.map(({name, version}) => [name, version]),
    [["first", "1.0"], ["second", "1.0"], ["shared", "1.0"], ["optional", "1.0"]]);
  assert.deepEqual(result.nodes.find(({name}) => name === "optional").externalRequirements, ["libxml2"]);
});

test("reports a missing package, a wheel shortage, and contradictory versions distinctly", async () => {
  const incompatible = await fixture({
    first: [release("first", "1.0", {deps:["shared>=2"]})],
    second: [release("second", "1.0", {deps:["shared<2"]})],
    shared: [release("shared", "2.0"), release("shared", "1.0")],
  }, ["first", "second"]);
  assert(!incompatible.ready);
  assert.equal(incompatible.nodes.find(({name}) => name === "shared").status, "conflict");
  const absent = await fixture({first: [release("first", "1.0")]}, ["first", "absent"]);
  assert.equal(absent.nodes.find(({name}) => name === "absent").status, "missing");
  assert.equal(absent.nodes.find(({name}) => name === "first").status, "ok");
  const sdist = await fixture({first: [release("first", "1.0", {tags:"cp314-cp314-manylinux_2_39_aarch64"})]}, ["first"]);
  assert.equal(sdist.nodes[0].status, "no-wheel");
});

test("a source-only input does not interrupt a separate wheel dependency graph", async () => {
  const filename = "source_only-1.0.tar.gz";
  const distribution = {file: {filename, url: wheelHost + filename, hashes: {sha256: hash(filename)},
    "requires-python": ">=3.12", yanked: false}};
  const result = await fixture({
    sample: [release("sample", "1.0", {deps: ["helper"]})],
    "source-only": [distribution],
    helper: [release("helper", "1.0")],
  }, ["sample", "source-only"]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.nodes.map(({name, status}) => [name, status]),
    [["sample", "ok"], ["source-only", "source"], ["helper", "ok"]]);
  assert.equal(result.nodes[1].sourceDistribution.filename, filename);
});

test("retains an individual result when another wheel has an unresolved indirect dependency", async () => {
  const result = await fixture({
    first: [release("first", "1.0", {deps: ["absent"]})],
    second: [release("second", "1.0", {deps: ["helper"]})],
    helper: [release("helper", "1.0")],
  }, ["first", "second"]);
  assert.equal(result.ready, false);
  assert.equal(result.nodes.find(({name}) => name === "absent").status, "missing");
  assert.deepEqual(result.individual.map(({root, nodes}) => [root, nodes.map(({name}) => name)]),
    [["second", ["second", "helper"]]]);
});

test("refuses a wheel when its Core Metadata digest does not match", async () => {
  const item = release("bad", "1.0");
  item.metadata += "modified";
  const result = await fixture({bad: [item]}, ["bad"]);
  assert(!result.ready);
  assert.match(result.nodes[0].detail, /SHA-256/);
});

async function loadBundledIndex() {
  const originalFetch = globalThis.fetch;
  try {
    const raw = await readFile(new URL("../dist/data/ubuntu-noble-arm64.json.gz", import.meta.url));
    globalThis.fetch = async () => new Response(raw);
    return await loadAptIndex();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("pins the real Ubuntu Python runtime and emits a standalone wheel-only Dockerfile", async () => {
  const index = await loadBundledIndex();
  const patch = catalog.noble.python;
  const minor = patch.split(".").slice(0, 2).join(".");
  const choices = pythonVersionChoices("noble");
  assert.equal(choices.defaultVersion, minor);
  assert(!choices.investigationOnly.includes(minor));
  const base = selectPythonBase(minor, index);
  assert.equal(base.pythonVersion, patch);
  assert.equal(selectPythonBase(minor + ".999999", index).status, "pending");
  assert.equal(selectPythonBase("3.999999", index).status, "pending");
  const investigation = await withPyPiFixture({demo: [release("demo", "1.0", {external:["libxml2"]})]},
    () => inspectPythonTarget({...pythonTarget(minor, index), requested: ["demo"]}));
  const {python, apt} = investigation;
  assert.equal(investigation.pythonVersion, patch);
  assert.equal(investigation.base.status, "ok");
  assert.equal(apt.plan.status, "ok");
  assert.deepEqual(apt.pins.map(({name}) => name), PYTHON_APT);
  assert(apt.evidence.some(({kind, included}) => kind === "Requires-External" && !included));
  const request = {language: "python", base, apt, python, requested: ["demo"], startedAt: "2026-11-27T00:00:00Z"};
  const text = makeDockerfile(request);
  assert(text.includes("python" + minor + "="));
  const hashes = dockerfileHashes(request);
  assert(text.includes("FROM " + hashes.baseImage.reference + "@" + hashes.baseImage.digest));
  assert.equal(hashes.pythonSource, null);
  assert.deepEqual(hashes.wheels.map(({name}) => name), ["demo"]);
  assert(text.includes(hashes.wheels[0].url + " --hash=sha256:" + hashes.wheels[0].sha256));
  assert.equal(makeDockerfile({...request, base: {...base, pythonVersion: minor + ".999999"}}), "");
  assert.match(text, /demo @ https:\/\/files\.pythonhosted\.org\/.* --hash=sha256:[0-9a-f]{64}/);
  assert.match(text, /--no-index --require-hashes --only-binary=:all:/);
  assert.match(text, /python -m pip check/);
  assert(!/^COPY /m.test(text));
  for (const [, shell] of text.matchAll(/^RUN <<'SH'\n(.*?)^SH$/gms)) {
    assert.equal(spawnSync("/bin/sh", ["-n"], {input:shell}).status, 0);
  }
  assert.equal(makeDockerfile({...request, apt: null}), "");
  assert.equal(makeDockerfile({...request, python: {...python, ready: false}}), "");
});
