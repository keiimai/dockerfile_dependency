import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadAptIndex, inspectApt } from "../dist/apt-resolver.mjs";
import { dockerfileBlockers, makeDockerfile, selectBase } from "../dist/dockerfile.mjs";

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
  row("libabsl-dev", "20220623.1-1"),
  row("cmake", "3.28.3-1"),
  row("make", "4.3-1"),
  row("pkg-config", "1.8.1-1"),
  row("libssl-dev", "3.0-1", "libssl3"),
  row("libssl3", "3.0-1"),
  row("libcurl4-openssl-dev", "8.5.0-1"),
  row("libcurl4-gnutls-dev", "8.5.0-1"),
  row("pandoc", "3.1.3-1"),
];
const payload = {
  schema: 1, architecture: "arm64", snapshot,
  base: "https://snapshot.ubuntu.com/ubuntu/" + snapshot,
  suites: ["noble"], components: ["main"], sources: [], packages, libraries: {"libssl.so.3": ["libssl3"]},
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


test("missing explicit Ubuntu packages and unavailable required versions cannot be omitted", () => {
  const apt = inspectApt([{name: "example", system: "Abseil >= 20230802.0"}], ["absent", "make"], index);
  assert.equal(apt.plan.status, "pending");
  assert.deepEqual(apt.pins, []);
  assert.equal(apt.evidence.find((row) => row.text === "absent").status, "missing");
  assert.equal(apt.evidence.find((row) => row.text === "make").status, "candidate");
  assert(dockerfileBlockers(report(apt)).some((reason) => reason.includes("absent")));
  assert.equal(makeDockerfile(report(apt)), "");
  assert.equal(makeDockerfile({...report(null), ubuntuRequested: ["make"]}), "");
});

test("plans the documented s2 release with bundled Abseil and groups the confirmed APT evidence", () => {
  const s2 = {
    name: "s2", version: "1.1.13", distribution: {current: "https://cloud.r-project.org/src/contrib/s2_1.1.13.tar.gz"},
    system: "cmake, OpenSSL >= 1.0.1, Abseil >= 20230802.0",
    sysreqHint: "libabsl-dev cmake libssl-dev", shlibs: [{shlib: "libssl"}],
  };
  const apt = inspectApt([s2], [], index);
  assert.equal(apt.plan.status, "ok");
  assert.deepEqual(apt.pins.map(({name}) => name), ["cmake", "libssl-dev", "make", "pkg-config"]);
  assert.equal(apt.evidence.find(({category}) => category === "bundled").source, s2.distribution.current);
  assert(apt.evidence.some(({text, status}) => text === "cmake" && status === "covered"));
  assert(apt.evidence.some(({library, status, coveredBy}) => library?.shlib === "libssl" && status === "covered" &&
    coveredBy.includes("libssl3:3.0-1:arm64")));
  assert(!apt.evidence.some(({status}) => status === "review" || status === "pending"));
  assert.equal(inspectApt([{...s2, version: "1.1.14"}], [], index).plan.status, "pending");
});

test("optional groups stay separate and an explicit provider resolves a required alternative", () => {
  const nodes = [{name: "example", system: "libcurl; for AWS S3 support, libssl, libxml2 (optional)"}];
  const ambiguous = inspectApt(nodes, [], index);
  assert.equal(ambiguous.plan.status, "pending");
  assert.match(ambiguous.plan.text, /複数の提供元/);
  assert.equal(ambiguous.evidence.filter(({status}) => status === "optional").length, 1);
  const explicit = inspectApt(nodes, ["libcurl4-gnutls-dev"], index);
  assert.equal(explicit.plan.status, "ok");
  assert.deepEqual(explicit.pins.map(({name}) => name), ["libcurl4-gnutls-dev"]);
});

test("checks documented version requirements that have a reference URL", () => {
  const apt = inspectApt([
    {name: "reprex", system: "pandoc (>= 2.0) - https://pandoc.org/"},
    {name: "rmarkdown", system: "pandoc (>= 2.8) - http://pandoc.org"},
  ], [], index);
  assert.equal(apt.plan.status, "ok");
  assert.deepEqual(apt.pins.map(({name}) => name), ["pandoc"]);
  assert.deepEqual(apt.evidence.map(({version}) => version), ["2.0", "2.8"]);
});
