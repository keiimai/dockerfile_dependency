import { readArchiveDescription, readDescription, sha256Archive } from "./r-artifact.mjs?v=verification-1";

import { supportedRuntime } from "./runtime-policy.mjs";
import archiveCatalog from "./archive-hashes.mjs";

export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/;
export const R_VERSION = /^\d+\.\d+\.\d+$/;
export const CRAN = "https://cloud.r-project.org/src/contrib";
export const UNIVERSE = "https://cran.r-universe.dev/api/packages/";
export const CRAN_HISTORY = "https://data.jsdelivr.com/v1/package/gh/cran/";
const CRAN_DESCRIPTION = "https://cdn.jsdelivr.net/gh/cran/";
const UNIVERSE_SOURCE = "https://cdn.r-universe.dev/";
const archiveLimit = 80;
const stateLimit = 120;
const download = (url) => fetch(url, {cache: "no-store", signal: AbortSignal.timeout(12000)});

const standard = new Set("base compiler datasets graphics grDevices grid methods parallel splines stats stats4 tcltk tools utils".split(" "));
const hardRoles = new Set(["Depends", "Imports", "LinkingTo"]);
const versionPattern = /^\d+(?:[.-]\d+)*$/;
const versionCondition = /^(>=|<=|==|=|>|<)\s*(\d+(?:[.-]\d+)*)$/;

export function compareR(left, right) {
  const a = left.split(/[.-]/).map(BigInt);
  const b = right.split(/[.-]/).map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0n;
    const y = b[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function matches(order, operator) {
  switch (operator) {
    case ">": case ">>": return order > 0;
    case ">=": return order >= 0;
    case "<": case "<<": return order < 0;
    case "<=": return order <= 0;
    case "==": case "=": return order === 0;
    default: throw new Error("版条件の演算子が不正です");
  }
}

function dependency(raw) {
  if (!PACKAGE_NAME.test(raw.package ?? "")) throw new Error("依存パッケージ名を解釈できません");
  if (!raw.version) return { name: raw.package, role: raw.role, operator: "", version: "" };
  const condition = String(raw.version).trim().match(versionCondition);
  if (!condition) throw new Error("依存の版条件を解釈できません: " + raw.version);
  return { name: raw.package, role: raw.role, operator: condition[1], version: condition[2] };
}

function readDependencies(data, description = false) {
  if (Array.isArray(data._dependencies)) {
    if (data._dependencies.some((row) => !row || typeof row.role !== "string")) {
      throw new Error("依存フィールドの形式が不明です");
    }
    return data._dependencies.filter((row) => hardRoles.has(row.role)).map(dependency);
  }
  if (!description && ![...hardRoles].some((role) => typeof data[role] === "string")) {
    throw new Error("依存フィールドを確認できません");
  }
  return [...hardRoles].flatMap((role) => (data[role] ?? "").split(",").filter((s) => s.trim())
    .map((s) => {
      const parsed = s.trim().match(/^([A-Za-z][A-Za-z0-9.]*)\s*(?:\(([^)]+)\))?$/);
      if (!parsed) throw new Error("依存フィールドを解釈できません: " + s);
      return dependency({ package: parsed[1], version: parsed[2], role });
    }));
}

async function fetchCurrent(name, rVersion) {
  if (name === "R" || standard.has(name)) {
    return { name, version: rVersion, source: "R 標準", status: "ok", deps: [] };
  }
  const metadata = UNIVERSE + encodeURIComponent(name);
  let response;
  let data;
  try {
    response = await download(metadata);
    if (response.status === 404) {
      return { name, metadata, status: "missing", detail: "CRAN 公開版 API で 404。公開直後は反映待ちの場合があります。", deps: [] };
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    data = await response.json();
  } catch (error) {
    return { name, metadata, status: "fetch", detail: String(error.message), deps: [] };
  }
  const result = { name, metadata, status: "pending", deps: [] };
  try {
    if (data.Package !== name || data._type !== "src" || !versionPattern.test(data.Version ?? "")) {
      throw new Error("CRAN 公開版のソースメタデータと照合できません");
    }
    result.version = data.Version;
    result.deps = readDependencies(data);
    result.system = typeof data.SystemRequirements === "string" ? data.SystemRequirements : "";
    result.sysreqHint = typeof data["Config/pak/sysreqs"] === "string" ? data["Config/pak/sysreqs"] : "";
    result.shlibs = Array.isArray(data._sysdeps) ? data._sysdeps
      .filter((row) => typeof row?.shlib === "string")
      .map(({shlib, headers, package: provider}) => ({ shlib, headers, provider })) : [];
    result.buildDistro = typeof data._distro === "string" ? data._distro : null;
    result.publication = typeof data["Date/Publication"] === "string" ? data["Date/Publication"] : null;
    const file = name + "_" + data.Version + ".tar.gz";
    if (data._file !== file) throw new Error("メタデータ上の配布物名が版と一致しません");
    const current = CRAN + "/" + file;
    const archive = CRAN + "/Archive/" + name + "/" + file;
    const sha256 = /^[a-f0-9]{64}$/.test(data._sha256 ?? "") ? data._sha256 : null;
    result.distribution = {
      file, current, archive, url: sha256 ? UNIVERSE_SOURCE + sha256 : current,
      repository: sha256 ? "r-universe" : "cran", sha256,
      hashEvidence: sha256 ? {method: "r-universe-api", source: metadata, field: "_sha256", checkedAt: new Date().toISOString()} : null,
    };
    if (/^windows$/i.test(data.OS_type ?? "")) {
      result.status = "conflict";
      result.detail = "公開候補の OS_type が Windows 専用です。";
    } else {
      result.status = "ok";
    }
    return result;
  } catch (error) {
    return { ...result, detail: error.message };
  }
}

async function archiveVersions(name) {
  const response = await download(CRAN_HISTORY + encodeURIComponent(name));
  if (response.status === 404) return [];
  if (!response.ok) throw new Error("HTTP " + response.status);
  const data = await response.json();
  if (!Array.isArray(data.versions)) throw new Error("CRAN 旧版一覧の形式を確認できません。");
  return [...new Set(data.versions.filter((version) => typeof version === "string" && versionPattern.test(version)))]
    .sort((a, b) => compareR(b, a));
}

export async function fetchArchived(name, version) {
  const metadata = CRAN_DESCRIPTION + name + "@" + version + "/DESCRIPTION";
  const response = await download(metadata);
  if (!response.ok) throw new Error("DESCRIPTION " + version + " — HTTP " + response.status);
  const data = readDescription(await response.text());
  if (data.Package !== name || data.Version !== version) {
    throw new Error("旧版の DESCRIPTION とパッケージ名・版が一致しません。");
  }
  const file = name + "_" + version + ".tar.gz";
  const url = CRAN + "/Archive/" + name + "/" + file;
  const windows = /^windows$/i.test(data.OS_type ?? "");
  return {
    name, version, metadata, status: windows ? "conflict" : "ok",
    detail: windows ? "この旧版の OS_type が Windows 専用です。" : undefined,
    deps: readDependencies(data, true), system: data.SystemRequirements ?? "",
    sysreqHint: data["Config/pak/sysreqs"] ?? "", publication: data["Date/Publication"] ?? null,
    distribution: {file, archive: url, url, repository: "archive", sha256: null},
  };
}

function dependencyKeys(deps) {
  return [...new Set(deps.map(({role, name, operator, version}) =>
    [role, name, operator, version].join(" ")))].sort().join("\n");
}

export function archiveIdentity(node) {
  return JSON.stringify([node.name, node.version, dependencyKeys(node.deps), (node.system ?? "").replace(/\s+/g, " ").trim()]);
}

const cacheKey = (url) => "cran-source-sha256-v1:" + url;

export async function pinRArchive(node, file, method = "local-file") {
  const {name, version, distribution} = node;
  if (distribution.sha256) return distribution;
  const description = await readArchiveDescription(file, name);
  const system = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  if (description.Package !== name || description.Version !== version ||
      dependencyKeys(readDependencies(description, true)) !== dependencyKeys(node.deps) ||
      system(description.SystemRequirements) !== system(node.system) ||
      /^windows$/i.test(description.OS_type ?? "")) {
    throw new Error("配布物の名前・版・依存条件が、調査した DESCRIPTION と一致しません。");
  }
  const sha256 = await sha256Archive(file);
  const hashEvidence = {method, source: method === "local-file" ? distribution.file : distribution.url,
    checkedAt: new Date().toISOString()};
  const entry = {sha256, url: distribution.url, identity: archiveIdentity(node), hashEvidence};
  try { globalThis.localStorage?.setItem(cacheKey(entry.url), JSON.stringify(entry)); } catch { /* Storage is optional. */ }
  return {...distribution, sha256, hashEvidence};
}

async function pinPublicArchive(node) {
  const url = node.distribution.url;
  let saved;
  try { saved = JSON.parse(globalThis.localStorage?.getItem(cacheKey(url)) ?? "null"); } catch { /* Storage unavailable. */ }
  for (const [via, entry] of [["catalog", archiveCatalog[url]], ["browser-cache", saved]]) {
    if (entry?.url === url && entry.identity === archiveIdentity(node) && /^[a-f0-9]{64}$/.test(entry.sha256) &&
        entry.hashEvidence?.method && entry.hashEvidence.checkedAt) {
      node.distribution = {...node.distribution, sha256: entry.sha256, hashEvidence: {...entry.hashEvidence, reusedVia: via}};
      return;
    }
  }
  try {
    const response = await fetch(node.distribution.url, {signal: AbortSignal.timeout(5000)});
    if (response.ok) node.distribution = await pinRArchive(node, await response.blob(), "downloaded-artifact");
  } catch {
    // The selected bytes can also be checked locally from a browser-selected file.
  }
}

function strongestRange(specs) {
  let lower;
  let upper;
  for (const {operator, version} of specs) {
    if (!operator) continue;
    const equal = operator === "=" || operator === "==";
    const bound = { version, strict: operator === ">" || operator === "<" };
    const tighter = (previous, direction) => {
      if (!previous) return true;
      const order = compareR(version, previous.version) * direction;
      return order > 0 || (order === 0 && bound.strict && !previous.strict);
    };
    if ((equal || operator.startsWith(">")) && tighter(lower, 1)) lower = bound;
    if ((equal || operator.startsWith("<")) && tighter(upper, -1)) upper = bound;
  }
  if (!lower || !upper) return false;
  const order = compareR(lower.version, upper.version);
  return order > 0 || (order === 0 && (lower.strict || upper.strict));
}

function installationOrder(nodes, roots) {
  const ordered = [];
  const placed = new Set();
  const active = new Set();
  const cycles = new Set();
  function visit(name) {
    if (placed.has(name)) return;
    if (active.has(name)) {
      cycles.add(name);
      return;
    }
    active.add(name);
    const node = nodes.get(name);
    node.deps.forEach((dep) => visit(dep.name));
    active.delete(name);
    placed.add(name);
    if (node.distribution) ordered.push(name);
  }
  roots.forEach(visit);
  return { ordered, cycles: [...cycles] };
}

async function resolveGraph(roots, getCandidate, progress) {
  const nodes = new Map();
  const queued = new Set(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length;) {
    const batch = queue.slice(i, i + 8);
    i += batch.length;
    const results = await Promise.all(batch.map(getCandidate));
    for (const node of results) {
      nodes.set(node.name, { ...node, incoming: [] });
      for (const dep of node.deps) {
        if (queued.has(dep.name)) continue;
        queued.add(dep.name);
        queue.push(dep.name);
      }
    }
    progress(nodes.size, queue.length);
  }
  for (const parent of nodes.values()) {
    for (const dep of parent.deps) {
      const target = nodes.get(dep.name);
      const applicable = Boolean(target.version && dep.operator);
      const ok = !applicable || matches(compareR(target.version, dep.version), dep.operator);
      const status = !target.version ? "pending" : ok ? "ok" : target.source ? "conflict" : "pending";
      target.incoming.push({ parent: parent.name, parentVersion: parent.version, ...dep, status });
    }
  }
  for (const node of nodes.values()) {
    node.relation = roots.includes(node.name) ? "入力" :
      node.incoming.some(({parent}) => roots.includes(parent)) ? "直接" : "間接";
    if (strongestRange(node.incoming)) {
      node.conditionStatus = "conflict";
      node.conditionDetail = "調査した親候補の版条件を同時に満たす版がありません。";
    } else if (node.incoming.some(({status}) => status === "conflict")) {
      node.conditionStatus = "conflict";
      node.conditionDetail = "指定の R 版または同梱の標準パッケージが版条件を満たしません。";
    } else if (node.incoming.some(({status}) => status === "pending") && node.version) {
      node.conditionStatus = "pending";
      node.conditionDetail = "調査した候補版が依存元の版条件を満たしません。";
    }
  }
  const { ordered, cycles } = installationOrder(nodes, roots);
  const ready = !cycles.length && [...nodes.values()].every((node) => node.status === "ok" && !node.conditionStatus);
  return { nodes, order: ordered, cycles, ready };
}

function satisfiesR(version, {operator, version: required}) {
  return !operator || matches(compareR(version, required), operator);
}

function causesOfFailure({nodes, cycles}) {
  const failures = [...nodes.values()].filter((node) =>
    node.conditionStatus || node.status === "missing" || node.status === "conflict").map(({name}) => name);
  const causes = [...new Set([...failures, ...cycles])];
  const seen = new Set(causes);
  // A different version of a parent can change its child's constraints.
  for (let i = 0; i < causes.length; i++) {
    const node = nodes.get(causes[i]);
    for (const {parent, status} of node.incoming) {
      if (seen.has(parent) || (node.source && status === "ok")) continue;
      seen.add(parent);
      causes.push(parent);
    }
  }
  return causes.map((name) => nodes.get(name)).filter((node) => !node.source);
}

export async function inspectR(roots, rVersion, progress = () => {}) {
  if (!supportedRuntime("r", rVersion)) throw new Error("R は 4.5.1 以降が対象です。");
  const current = new Map();
  const archiveLists = new Map();
  const archiveCandidates = new Map();
  const visited = new Set();
  const unavailable = new Map();
  let limited = false;

  function getCurrent(name) {
    if (!current.has(name)) current.set(name, fetchCurrent(name, rVersion));
    return current.get(name);
  }

  async function* alternatives(node) {
    const {name, incoming} = node;
    const fits = (version) => incoming.every((dep) => dep.parent === name || satisfiesR(version, dep));
    const live = await getCurrent(name);
    if (live.status === "ok" && live.version !== node.version && fits(live.version)) yield live;
    progress(archiveCandidates.size, null, "archive");
    if (!archiveLists.has(name)) archiveLists.set(name, archiveVersions(name).catch((error) => {
      unavailable.set(name, error.message);
      return [];
    }));
    for (const version of await archiveLists.get(name)) {
      if (version === node.version || (live.version && compareR(version, live.version) >= 0) || !fits(version)) continue;
      const key = name + "@" + version;
      if (!archiveCandidates.has(key)) {
        if (archiveCandidates.size >= archiveLimit) {
          limited = true;
          return;
        }
        progress(archiveCandidates.size + 1, null, "archive");
        archiveCandidates.set(key, fetchArchived(name, version).catch((error) => {
          unavailable.set(key, error.message);
          return null;
        }));
      }
      const candidate = await archiveCandidates.get(key);
      if (candidate?.status === "ok") yield candidate;
    }
  }

  let initial;
  async function search(overrides) {
    if (visited.size >= stateLimit || limited) {
      limited = true;
      return null;
    }
    const graph = await resolveGraph(roots, (name) => overrides.get(name) ?? getCurrent(name), progress);
    if (!initial) initial = graph;
    if (graph.ready) return graph;
    const key = [...graph.nodes.values()].filter((node) => node.distribution?.repository === "archive")
      .map(({name, version}) => name + "@" + version).sort().join(",");
    if (visited.has(key)) return null;
    visited.add(key);
    const reachable = [...overrides].filter(([name]) => graph.nodes.has(name));
    for (const node of causesOfFailure(graph)) {
      for await (const candidate of alternatives(node)) {
        const rCompatible = candidate.deps.every((dep) => {
          return (dep.name !== "R" && !standard.has(dep.name)) || satisfiesR(rVersion, dep);
        });
        if (!rCompatible) continue;
        const next = new Map(reachable);
        if (candidate.distribution.repository === "archive") next.set(node.name, candidate);
        else next.delete(node.name);
        const result = await search(next);
        if (result || limited) return result;
      }
      if (limited) break;
    }
    return null;
  }

  const selected = await search(new Map()) ?? initial;
  const nodes = [...selected.nodes.values()];
  if (selected.ready) {
    const toPin = nodes.filter((node) => node.distribution && !node.distribution.sha256);
    for (let i = 0; i < toPin.length; i += 4) {
      progress(i, toPin.length, "hash");
      await Promise.all(toPin.slice(i, i + 4).map(pinPublicArchive));
    }
  }
  const archiveSearch = {
    packages: archiveLists.size, candidates: archiveCandidates.size, limited,
    unavailable: [...unavailable].map(([name, reason]) => ({name, reason})),
  };
  return { ...selected, nodes, archiveSearch };
}
