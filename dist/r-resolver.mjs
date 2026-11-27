export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/;
export const R_VERSION = /^\d+\.\d+\.\d+$/;
export const CRAN = "https://cloud.r-project.org/src/contrib";
export const UNIVERSE = "https://cran.r-universe.dev/api/packages/";

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

function readDependencies(data) {
  if (Array.isArray(data._dependencies)) {
    if (data._dependencies.some((row) => !row || typeof row.role !== "string")) {
      throw new Error("依存フィールドの形式が不明です");
    }
    return data._dependencies.filter((row) => hardRoles.has(row.role)).map(dependency);
  }
  if (![...hardRoles].some((role) => typeof data[role] === "string")) {
    throw new Error("依存フィールドを確認できません");
  }
  return [...hardRoles].flatMap((role) => (data[role] ?? "").split(",").filter((s) => s.trim())
    .map((s) => {
      const parsed = s.trim().match(/^([A-Za-z][A-Za-z0-9.]*)\s*(?:\(([^)]+)\))?$/);
      if (!parsed) throw new Error("依存フィールドを解釈できません: " + s);
      return dependency({ package: parsed[1], version: parsed[2], role });
    }));
}

async function fetchPackage(name, rVersion) {
  if (name === "R" || standard.has(name)) {
    return { name, version: rVersion, source: "R 標準", status: "ok", deps: [] };
  }
  const metadata = UNIVERSE + encodeURIComponent(name);
  let response;
  let data;
  try {
    response = await fetch(metadata, { cache: "no-store", signal: AbortSignal.timeout(16000) });
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
    result.distribution = { file, current: CRAN + "/" + file, archive: CRAN + "/Archive/" + name + "/" + file };
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

export async function inspectR(roots, rVersion, progress) {
  const nodes = new Map();
  const queued = new Set(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length;) {
    const batch = queue.slice(i, i + 8);
    i += batch.length;
    const results = await Promise.all(batch.map((name) => fetchPackage(name, rVersion)));
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
      node.conditionDetail = "確認できた公開候補版が条件を満たしません。旧版の調査が必要です。";
    }
  }
  const { ordered, cycles } = installationOrder(nodes, roots);
  const ready = !cycles.length && [...nodes.values()].every((node) => node.status === "ok" && !node.conditionStatus);
  return { nodes: [...nodes.values()], order: ordered, cycles, ready };
}
