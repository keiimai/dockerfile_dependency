import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import catalog from "../dist/runtime-catalog.mjs";
import { loadAptIndex, inspectApt } from "../dist/apt-resolver.mjs";
import { makeDockerfile, selectPythonBase, PYTHON_APT } from "../dist/dockerfile.mjs";
import { normalizePythonName, pythonEnvironment, readRequirement, wheelCandidate } from "../dist/python-packaging.mjs";
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

async function fixture(catalog, names, pythonVersion = target) {
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
    return await inspectPython(names, pythonVersion, () => {});
  } finally {
    globalThis.fetch = previous;
  }
}

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
  const sdist = await fixture({first: [release("first", "1.0", {tags:"cp314-cp314-manylinux_2_39_aarch64"})]}, ["first"]);
  assert.equal(sdist.nodes[0].status, "pending");
});

test("refuses a wheel when its Core Metadata digest does not match", async () => {
  const item = release("bad", "1.0");
  item.metadata += "modified";
  const result = await fixture({bad: [item]}, ["bad"]);
  assert(!result.ready);
  assert.match(result.nodes[0].detail, /SHA-256/);
});

test("pins the real Ubuntu Python runtime and emits a standalone wheel-only Dockerfile", async () => {
  const originalFetch = globalThis.fetch;
  let index;
  try {
    const raw = await readFile(new URL("../dist/data/ubuntu-noble-arm64.json.gz", import.meta.url));
    globalThis.fetch = async () => new Response(raw);
    index = await loadAptIndex();
  } finally {
    globalThis.fetch = originalFetch;
  }
  const patch = catalog.noble.python;
  const minor = patch.split(".").slice(0, 2).join(".");
  const base = selectPythonBase(minor, index);
  assert.equal(base.pythonVersion, patch);
  assert.equal(selectPythonBase(minor + ".999999", index).status, "conflict");
  assert.equal(selectPythonBase("3.999999", index).status, "pending");
  const python = await fixture({demo: [release("demo", "1.0", {external:["libxml2"]})]}, ["demo"], patch);
  const apt = inspectApt(python.nodes, [], index, PYTHON_APT);
  assert.equal(apt.plan.status, "ok");
  assert.deepEqual(apt.pins.map(({name}) => name), PYTHON_APT);
  assert(apt.evidence.some(({kind, included}) => kind === "Requires-External" && !included));
  const request = {language: "python", base, apt, python, requested: ["demo"], startedAt: "2026-11-27T00:00:00Z"};
  const text = makeDockerfile(request);
  assert(text.includes("python" + minor + "="));
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
