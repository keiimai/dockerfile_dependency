import { inspectApt } from "./apt-resolver.mjs?v=runtime-summary-1";
import { pythonAptPackages, selectPythonBase } from "./dockerfile.mjs?v=runtime-summary-1";
import { inspectPython } from "./python-resolver.mjs?v=dependency-evidence-1";
import catalog from "./runtime-catalog.mjs?v=runtime-summary-1";
import { TARGETS } from "./targets.mjs?v=runtime-summary-1";

const pythonReleases = "https://www.python.org/downloads/source/";

export function pythonVersionChoices(release) {
  const defaultVersion = TARGETS[release].python;
  const otherSeries = Object.keys(catalog.pythonSeries).sort((left, right) =>
    right.localeCompare(left, "en", {numeric: true}));
  return {defaultVersion, investigationOnly: otherSeries.slice(0, 6).filter((version) => version !== defaultVersion)};
}

export async function inspectPythonTarget({requested, version, ubuntuRequested, release, index, progress}) {
  const target = TARGETS[release];
  const minor = version.split(".").slice(0, 2).join(".");
  const needsDefaultRuntime = minor === target.python;
  const bootstrap = needsDefaultRuntime ? pythonAptPackages(release) : [];
  const runtimePlan = index && needsDefaultRuntime ? inspectApt([], ubuntuRequested, index, bootstrap) : null;
  const base = selectPythonBase(version, index, release, runtimePlan);

  let pythonVersion = version;
  let pythonVersionNote = null;
  let pythonVersionSource = null;
  if (version === minor) {
    const published = catalog.pythonSeries[minor];
    pythonVersion = base.pythonVersion ?? (needsDefaultRuntime ? catalog[release].python : published ?? minor + ".0");
    if (!base.pythonVersion && needsDefaultRuntime) {
      pythonVersionNote = "Ubuntu の公開カタログに記載された CPython " + pythonVersion + " で調査しました。";
    } else if (!needsDefaultRuntime && published) {
      pythonVersionNote = "Python.org で確認したこの系列の安定版で調査しました。";
      pythonVersionSource = pythonReleases;
    } else if (!needsDefaultRuntime) {
      pythonVersionNote = "パッチ版の指定がないため CPython " + pythonVersion + " で調査しました。";
    }
  }

  const python = await inspectPython(requested, pythonVersion, progress, target.glibc);
  const hasExternal = python.nodes.some((node) => node.externalRequirements?.length);
  const required = base.status === "ok" ? bootstrap : [];
  const apt = base.status === "ok" && !hasExternal ? runtimePlan
    : index ? inspectApt(python.nodes, ubuntuRequested, index, required) : null;

  return {base, pythonVersion, pythonVersionNote, pythonVersionSource, python, apt};
}
