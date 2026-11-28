import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {dockerfileBlockers, dockerfileHashes, makeDockerfile, selectBase} from "../dist/dockerfile.mjs";
import {CRAN, CRAN_HISTORY, UNIVERSE, inspectR, pinRArchive} from "../dist/r-resolver.mjs";

const digest = "b".repeat(64);

function current(name, version, deps = []) {
  return {
    Package: name, Version: version, _type: "src", _file: name + "_" + version + ".tar.gz",
    _dependencies: deps, _sha256: digest,
  };
}

function replaceFetch(t, currentPackages, history, description, files = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    const name = url.split("/").at(-1);
    if (url.startsWith(UNIVERSE)) {
      return currentPackages[name] ? Response.json(currentPackages[name]) : new Response(null, {status: 404});
    }
    if (url.startsWith(CRAN_HISTORY)) {
      const item = history[name];
      if (item === "error") throw new Error("Network unavailable");
      return item ? Response.json({versions: item}) : new Response(null, {status: 404});
    }
    if (url.includes("cdn.jsdelivr.net/gh/cran/")) {
      const key = url.split("/").at(-2);
      return description[key] ? new Response(description[key]) : new Response(null, {status: 404});
    }
    if (files[name]) return new Response(files[name]);
    throw new Error("Cross-origin source transfer unavailable");
  });
  return requests;
}

function sourceTar(name, description) {
  const header = Buffer.alloc(512);
  const text = Buffer.from(description);
  header.write(name + "/DESCRIPTION", 0);
  header.write(text.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write("0", 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padding = (512 - text.length % 512) % 512;
  return gzipSync(Buffer.concat([header, text, Buffer.alloc(padding + 1024)]));
}

function report(r) {
  return {language: "r", base: selectBase("4.5.3"), r, requested: ["Sample"], startedAt: "2026-11-28T00:00:00Z"};
}

test("pins R-universe's current source to its own content address", async (t) => {
  const calls = replaceFetch(t, {Sample: current("Sample", "2.0")}, {}, {});
  const r = await inspectR(["Sample"], "4.5.3");
  assert.equal(r.ready, true);
  assert.equal(calls.length, 1);
  const docker = makeDockerfile(report(r));
  const url = "https://cdn.r-universe.dev/" + digest;
  assert(docker.includes("install_cran 'Sample' '2.0' '" + url + "' '' '" + digest + "'"));
  assert(docker.indexOf("sha256sum -c -") < docker.indexOf("tar -xOzf"));
  assert.deepEqual(dockerfileHashes(report(r)).rSources, [{name: "Sample", version: "2.0", url, sha256: digest}]);
});

test("tries old R releases and resolves a shared indirect dependency across roots", async (t) => {
  const req = (name, version) => ({role: "Imports", package: name, version});
  replaceFetch(t, {
    Sample: current("Sample", "2.0", [req("Bridge", ">= 2.0"), req("Unused", "")]),
    Other: current("Other", "1.0", [req("Bridge", "< 2.0")]),
    Bridge: current("Bridge", "2.1"),
    Unused: current("Unused", "3.0"),
  }, {Sample: ["2.0", "1.0", "dev"], Bridge: ["2.1", "1.2"]}, {
    "Sample@1.0": "Package: Sample\nVersion: 1.0\nImports: Bridge (>= 1.0)\n",
    "Bridge@1.2": "Package: Bridge\nVersion: 1.2\nDepends: R (>= 4.4)\n",
  });
  const r = await inspectR(["Sample", "Other"], "4.5.3");
  assert(r.ready);
  assert.deepEqual(r.order, ["Bridge", "Sample", "Other"]);
  assert.deepEqual(r.nodes.filter((node) => node.distribution?.repository === "archive").map(({name, version}) =>
    [name, version]), [["Sample", "1.0"], ["Bridge", "1.2"]]);
  assert(!r.nodes.some(({name}) => name === "Unused"));
  assert.equal(makeDockerfile(report(r)), "");
});

test("checks an archived DESCRIPTION and hashes the original gzipped artifact", async (t) => {
  const description = "Package: Sample\nVersion: 1.2\nDepends:\n    R (>= 4.4)\nSystemRequirements: GDAL\n";
  const tarball = sourceTar("Sample", description);
  replaceFetch(t, {Sample: current("Sample", "2.0", [{role: "Depends", package: "R", version: ">= 4.6"}])},
    {Sample: ["2.0", "1.3", "1.2"]}, {
      "Sample@1.3": "Package: Sample\nVersion: 1.3\nDepends: R (>= 4.6)\n",
      "Sample@1.2": description,
    });
  const r = await inspectR(["Sample"], "4.5.3");
  const node = r.nodes[0];
  assert(r.ready);
  assert.equal(node.version, "1.2");
  assert.equal(node.distribution.sha256, null);
  assert(dockerfileBlockers(report(r)).some((note) => note.includes("Sample 1.2")));
  await assert.rejects(pinRArchive(node, new Blob([sourceTar("Sample", description.replace("GDAL", "libxml2"))])),
    /一致しません/);
  await assert.rejects(pinRArchive(node, new Blob(["not a tar file"])));
  node.distribution = await pinRArchive(node, new Blob([tarball]));
  const expected = createHash("sha256").update(tarball).digest("hex");
  assert.equal(node.distribution.sha256, expected);
  const url = CRAN + "/Archive/Sample/Sample_1.2.tar.gz";
  assert(makeDockerfile(report(r)).includes("install_cran 'Sample' '1.2' '" + url + "' '' '" + expected + "'"));
  assert.deepEqual(dockerfileHashes(report(r)).rSources, [{name: "Sample", version: "1.2", url, sha256: expected}]);
});

test("falls back from no public current release and distinguishes missing and unavailable old metadata", async (t) => {
  const description = "Package: Former\nVersion: 1.0\n";
  const tarball = sourceTar("Former", description);
  replaceFetch(t, {}, {Former: ["1.0"], Unclear: "error"}, {"Former@1.0": description},
    {"Former_1.0.tar.gz": tarball});
  const former = await inspectR(["Former"], "4.5.3");
  assert(former.ready);
  assert.equal(former.nodes[0].distribution.sha256, createHash("sha256").update(tarball).digest("hex"));
  const result = await inspectR(["Missing", "Unclear"], "4.5.3");
  assert(!result.ready);
  assert.equal(result.nodes.find(({name}) => name === "Missing").status, "missing");
  assert.deepEqual(result.archiveSearch.unavailable, [{name: "Unclear", reason: "Network unavailable"}]);
});
