import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadAptIndex, inspectApt } from "../dist/apt-resolver.mjs";
import { makeDockerfile, selectBase } from "../dist/dockerfile.mjs";

const snapshot = "20261127T070249Z";
const row = (name, version, depends = "", { provides = "", conflicts = "", breaks = "", preDepends = "" } = {}) =>
  [name, version, "arm64", depends, preDepends, provides, "", conflicts, breaks, "", "noble", "main"];

const packages = [
  row("root-a", "1.0", "shared (= 1.0)"),
  row("root-b", "1.0", "bridge"),
  row("bridge", "1.0", "", {preDepends: "shared (= 2.0)"}),
  row("root-b-choice", "2.0", "bridge"),
  row("root-b-choice", "1.0", "shared (= 1.0)"),
  row("root-other", "1.0", "shared (= 2.0) | replacement"),
  row("root-virtual", "1.0", "virtual-shared (>= 2.0)"),
  row("root-missing", "1.0", "shared (= 2.0) | absent"),
  row("root-unparsed", "1.0", "shared (= 2.0) | helper [arm64]"),
  row("root-one", "1.0", "left, right"),
  row("left", "1.0", "shared (= 1.0)"),
  row("right", "1.0", "shared (= 2.0)"),
  row("root-breaks", "1.0", "breaking-provider"),
  row("breaking-provider", "1.0", "", {breaks: "shared (<< 2.0)"}),
  row("unrelated", "1.0"),
  row("shared", "1.0", "", {provides: "virtual-shared (= 1.0)"}),
  row("shared", "2.0", "", {provides: "virtual-shared (= 2.0)"}),
  row("replacement", "1.0", "", {provides: "virtual-shared (= 2.0)"}),
];
const payload = {
  schema: 1, architecture: "arm64", snapshot,
  base: "https://snapshot.ubuntu.com/ubuntu/" + snapshot,
  suites: ["noble"], components: ["main"], sources: [], packages, libraries: {},
};
const originalFetch = globalThis.fetch;
let index;
try {
  globalThis.fetch = async () => new Response(gzipSync(JSON.stringify(payload)));
  index = await loadAptIndex();
} finally {
  globalThis.fetch = originalFetch;
}

function report(apt) {
  return {
    base: selectBase("4.5.3"), r: {ready: true, order: []}, apt,
    requested: ["stats"], startedAt: "2026-11-27T00:00:00Z",
  };
}

test("different roots cannot require different versions of the same indirect package", () => {
  const apt = inspectApt([], ["root-a", "root-b", "unrelated"], index);
  assert.equal(apt.plan.status, "conflict");
  assert.deepEqual(apt.pins, []);
  assert.match(apt.issues[0].detail.join(" "), /shared.*2\.0.*shared.*1\.0|shared.*1\.0.*shared.*2\.0/);
  assert.equal(makeDockerfile(report(apt)), "");
});

test("a conflict between two dependency paths of one root is detected", () => {
  const apt = inspectApt([], ["root-one"], index);
  assert.equal(apt.plan.status, "conflict");
  assert.deepEqual(apt.pins, []);
});

test("older root versions and dependency alternatives can avoid a conflict", () => {
  const apt = inspectApt([], ["root-a", "root-b-choice", "root-other", "root-virtual"], index);
  assert.equal(apt.plan.status, "ok");
  assert.deepEqual(apt.pins.map(({name, version}) => [name, version]),
    [["root-a", "1.0"], ["root-b-choice", "1.0"], ["root-other", "1.0"], ["root-virtual", "1.0"]]);
  assert.match(makeDockerfile(report(apt)), /'root-b-choice=1\.0'/);
});

test("Breaks on a transitive package can invalidate a combination", () => {
  const apt = inspectApt([], ["root-a", "root-breaks"], index);
  assert.equal(apt.plan.status, "conflict");
  assert.match(apt.issues[0].detail.join(" "), /Breaks/);
  assert.deepEqual(apt.pins, []);
});

test("a missing or unrecognized alternative is reported as pending instead of a known conflict", () => {
  for (const name of ["root-missing", "root-unparsed"]) {
    const apt = inspectApt([], ["root-a", name], index);
    assert.equal(apt.plan.status, "pending");
    assert.deepEqual(apt.pins, []);
    assert.equal(makeDockerfile(report(apt)), "");
  }
});
