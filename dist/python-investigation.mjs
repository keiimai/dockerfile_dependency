import { inspectApt } from "./apt-resolver.mjs?v=verification-1";
import { pythonAptPackages, pythonBuildPackages, pythonRuntimeChoice, selectPythonBase } from "./dockerfile.mjs?v=verification-1";
import { inspectPython } from "./python-resolver.mjs?v=verification-1";
import catalog from "./runtime-catalog.mjs?v=verification-1";
import { TARGETS } from "./targets.mjs?v=verification-1";

import { supportedRuntime } from "./runtime-policy.mjs";

const pythonReleases = "https://www.python.org/downloads/source/";

export function pythonVersionChoices(release) {
  const defaultVersion = TARGETS[release].python;
  const alternatives = Object.keys(catalog.pythonSeries).filter((v) => supportedRuntime("python", v)).sort((left, right) =>
    right.localeCompare(left, "en", {numeric: true})).slice(0, 6)
    .filter((version) => version !== defaultVersion);
  const sourceVersions = alternatives.filter((version) => pythonRuntimeChoice(version, release).source);
  return {defaultVersion, sourceVersions, investigationOnly: alternatives.filter((version) => !sourceVersions.includes(version))};
}

export function applyPythonIndex({version, ubuntuRequested, release, index}, python) {
  if (!supportedRuntime("python", version)) throw new Error("Python は 3.10 以降が対象です。");
  const runtime = pythonRuntimeChoice(version, release);
  const required = runtime.method === "apt" ? pythonAptPackages(release) : runtime.source ? pythonBuildPackages : [];
  const runtimePlan = index && required.length ? inspectApt([], ubuntuRequested, index, required) : null;
  const base = selectPythonBase(version, index, release, runtimePlan);

  const pythonVersion = base.status === "ok" ? base.pythonVersion : runtime.version;
  let pythonVersionNote = null;
  let pythonVersionSource = null;
  if (version !== pythonVersion && runtime.method === "source") {
    if (catalog.pythonSeries[version]) {
      pythonVersionNote = "Python.org で確認したこの系列の安定版で調査しました。";
      pythonVersionSource = pythonReleases;
    } else {
      pythonVersionNote = "パッチ版の指定がないため CPython " + pythonVersion + " で調査しました。";
    }
  } else if (version !== pythonVersion && base.status !== "ok") {
    pythonVersionNote = "Ubuntu の公開カタログに記載された CPython " + pythonVersion + " で調査しました。";
  }

  if (python.environment.python_full_version !== pythonVersion) throw new Error("Ubuntu 索引と調査した Python 版が一致しません。");
  const hasExternal = python.nodes.some((node) => node.externalRequirements?.length);
  const apt = runtimePlan && !hasExternal ? runtimePlan
    : index ? inspectApt(python.nodes, ubuntuRequested, index, required) : null;

  return {base, pythonVersion, pythonVersionNote, pythonVersionSource, python, apt};
}

export async function inspectPythonTarget(options) {
  const {requested, version, release, progress} = options;
  if (!supportedRuntime("python", version)) throw new Error("Python は 3.10 以降が対象です。");
  const runtime = pythonRuntimeChoice(version, release);
  const python = await inspectPython(requested, runtime.version, progress, TARGETS[release].glibc);
  return applyPythonIndex(options, python);
}
