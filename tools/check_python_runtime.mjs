import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { inspectApt, parseAptIndex } from "../dist/apt-resolver.mjs";
import { pythonAptPackages, upstreamPythonVersion } from "../dist/dockerfile.mjs";

const [release, file] = process.argv.slice(2);
const index = parseAptIndex(JSON.parse(gunzipSync(readFileSync(file))));
if (index.snapshot.suites[0] !== release) throw new Error("APT snapshot has the wrong release");

const dependency = index.real.get("python3")?.[0]?.depends.match(/(?:^|,\s*)python(3\.\d+)(?=\s|,|$)/);
if (!dependency) throw new Error("Cannot determine Ubuntu's default Python minor");
const minor = dependency[1];
const name = "python" + minor;
const packages = pythonAptPackages(release, minor);
const {plan, pins} = inspectApt([], [], index, packages);
const version = upstreamPythonVersion(pins.find((pin) => pin.name === name));
if (plan.status !== "ok" || !packages.every((name) => pins.some((pin) => pin.name === name)) ||
    !version?.startsWith(minor + ".")) {
  throw new Error("Cannot pin the complete Python runtime against this snapshot");
}
console.log(version);
