import { inspectApt } from "./apt-resolver.mjs?v=dependency-evidence-1";
import { pythonAptPackages, selectPythonBase } from "./dockerfile.mjs?v=dependency-evidence-1";
import { inspectPython } from "./python-resolver.mjs?v=dependency-evidence-1";
import catalog from "./runtime-catalog.mjs?v=dependency-evidence-1";
import { TARGETS } from "./targets.mjs?v=dependency-evidence-1";

export async function inspectPythonTarget({requested, version, ubuntuRequested, release, index, progress}) {
  const target = TARGETS[release];
  const minor = version.split(".").slice(0, 2).join(".");
  const needsDefaultRuntime = minor === target.python;
  const bootstrap = needsDefaultRuntime ? pythonAptPackages(release) : [];
  const runtimePlan = index && needsDefaultRuntime ? inspectApt([], ubuntuRequested, index, bootstrap) : null;
  const base = selectPythonBase(version, index, release, runtimePlan);

  let pythonVersion = version;
  let pythonVersionNote = null;
  if (version === minor) {
    pythonVersion = base.pythonVersion ?? (needsDefaultRuntime ? catalog[release].python : minor + ".0");
    if (!base.pythonVersion) {
      pythonVersionNote = needsDefaultRuntime
        ? "Ubuntu の公開カタログに記載された CPython " + pythonVersion + " で調査しました。"
        : "パッチ版の指定がないため CPython " + pythonVersion + " で調査しました。";
    }
  }

  const python = await inspectPython(requested, pythonVersion, progress, target.glibc);
  const hasExternal = python.nodes.some((node) => node.externalRequirements?.length);
  const required = base.status === "ok" ? bootstrap : [];
  const apt = base.status === "ok" && !hasExternal ? runtimePlan
    : index ? inspectApt(python.nodes, ubuntuRequested, index, required) : null;

  return {base, pythonVersion, pythonVersionNote, python, apt};
}
