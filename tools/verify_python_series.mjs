import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import catalog from "../dist/runtime-catalog.mjs";
import verified from "../dist/build-records.mjs";
import { parseAptIndex } from "../dist/apt-resolver.mjs";
import { inspectPythonTarget } from "../dist/python-investigation.mjs";
import { makeDockerfile } from "../dist/dockerfile.mjs";
import { recipeDigest } from "../dist/build-evidence.mjs";

// Compare to the previously published catalog so an unseen minor cannot be promoted without a native check.
const previous = JSON.parse(execFileSync("git", ["show", "HEAD:dist/runtime-catalog.mjs"], {encoding:"utf8"})
  .replace(/^export default /, "").trim().replace(/;$/, ""));
const entries = Object.entries(catalog.pythonSeries).filter(([v]) => Number(v.split(".")[1]) >= 10);
const newest = entries.toSorted(([a], [b]) => Number(b.split(".")[1]) - Number(a.split(".")[1]))[0][0];
const series = entries.filter(([v]) => !previous.pythonSeries[v] || v === newest ||
  verified.some((row) => row.series === v));
const records = [...verified];
const run = process.env.GITHUB_SERVER_URL + "/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + process.env.GITHUB_RUN_ID;
mkdirSync("_tmp/runtime-check", {recursive:true});
for (const release of ["noble", "resolute"]) {
  const index = parseAptIndex(JSON.parse(gunzipSync(readFileSync("dist/data/ubuntu-" + release + "-arm64.json.gz"))));
  for (const [minor, version] of series) {
    const result = await inspectPythonTarget({release, version, index, requested:[], ubuntuRequested:[], progress() {}});
    const dockerfile = makeDockerfile({...result, requested:[], startedAt:"runtime", language:"python"});
    if (!dockerfile) throw new Error("Cannot generate CPython " + version + " on " + release);
    const recipe = await recipeDigest(dockerfile);
    if (records.some((row) => row.scope === "python-runtime" && row.recipe === recipe && row.status === "passed")) continue;
    const image = "runtime-check:" + release + "-" + version;
    console.log("Building and starting", image);
    execFileSync("docker", ["build", "--platform", "linux/arm64", "-t", image, "-f", "-", "_tmp/runtime-check"],
      {input: dockerfile, stdio:["pipe","inherit","inherit"]});
    const program = "import platform,sys,ssl,sqlite3,venv,bz2,lzma,zlib,ctypes,readline; " +
      "assert platform.machine() == 'aarch64'; assert platform.python_version() == sys.argv[1]; " +
      "assert sys.prefix == '/opt/python'; assert sqlite3.connect(':memory:').execute('select 1').fetchone() == (1,); " +
      "print(platform.python_version(), ssl.OPENSSL_VERSION, sqlite3.sqlite_version)";
    execFileSync("docker", ["run", "--rm", "--network=none", image, "python", "-c", program, version], {stdio:"inherit"});
    records.push({scope:"python-runtime", status:"passed", series:minor, version, release, recipe,
      image:result.base.image, platform:"linux/arm64", sha256:result.base.pythonSource?.sha256 ?? null,
      snapshot:catalog[release].snapshot, checkedAt:new Date().toISOString(), source:run, checks:["arm64","python_version","venv","ssl","sqlite3","bz2","lzma","zlib","ctypes","readline"]});
  }
}
writeFileSync("dist/build-records.mjs", "export default " + JSON.stringify(records,null,2) + ";\n");
