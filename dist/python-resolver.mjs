import {
  compare, meetsPythonRange, normalizePythonName, pythonEnvironment, readRequirement,
  readWheelHeaders, valid, validPythonRange, wheelCandidate,
} from "./python-packaging.mjs";

export const PYPI = "https://pypi.org/simple/";
const indexUrl = (name) => PYPI + encodeURIComponent(name) + "/";
const requestsLimit = 160;
const decisionsLimit = 400;

async function fetchPublic(url, options = {}) {
  return fetch(url, { cache: "no-store", signal: AbortSignal.timeout(16000), ...options });
}

async function wheelsFor(name, version) {
  try {
    const response = await fetchPublic(indexUrl(name), {headers: {Accept: "application/vnd.pypi.simple.v1+json"}});
    if (response.status === 404) return {status: "missing", detail: "PyPI の索引に見つかりません（HTTP 404）。"};
    if (!response.ok) throw new Error("HTTP " + response.status);
    const index = await response.json();
    if (!Array.isArray(index.files) || typeof index.name !== "string" || normalizePythonName(index.name) !== name) {
      throw new Error("PyPI の索引形式が一致しません");
    }
    const wheels = index.files.map((file) => wheelCandidate(file, name, version)).filter(Boolean);
    wheels.sort((a, b) => compare(b.version, a.version) ||
      Number(Boolean(b.metadata)) - Number(Boolean(a.metadata)) || b.rank - a.rank);
    return {wheels};
  } catch (error) {
    return {status: "fetch", detail: "PyPI 索引の取得失敗 — " + error.message};
  }
}

async function wheelMetadata(name, wheel, version) {
  if (!wheel.metadata) return {status: "pending", detail: wheel.filename + " の Core Metadata が公開索引にありません。"};
  const url = wheel.url + ".metadata";
  let bytes;
  try {
    const response = await fetchPublic(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    bytes = await response.arrayBuffer();
  } catch (error) {
    return {status: "fetch", detail: "wheel メタデータの取得失敗 — " + error.message, metadata: url};
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (wheel.metadata.sha256 && wheel.metadata.sha256.toLowerCase() !== sha256) {
      throw new Error("Core Metadata の SHA-256 が PyPI 索引と一致しません");
    }
    const fields = readWheelHeaders(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    const metadataName = fields.get("name")?.[0];
    const metadataVersion = fields.get("version")?.[0];
    if (!metadataName || normalizePythonName(metadataName) !== name || !valid(metadataVersion ?? "") ||
        compare(metadataVersion, wheel.version) !== 0) {
      throw new Error("Core Metadata の Name または Version が wheel と一致しません");
    }
    const requiresPython = fields.get("requires-python")?.[0] ?? "";
    if (!validPythonRange(requiresPython) || !meetsPythonRange(version, requiresPython)) {
      throw new Error("Core Metadata の Requires-Python を満たしません");
    }
    const {metadata: _hashes, rank: _rank, ...distribution} = wheel;
    return {
      name, version: wheel.version, status: "ok", metadata: url, distribution,
      metadataSha256: sha256, requiresPython,
      requires: fields.get("requires-dist") ?? [],
      externalRequirements: fields.get("requires-external") ?? [],
    };
  } catch (error) {
    return {status: "pending", detail: error.message, metadata: url};
  }
}

function dependencyGraph(roots, selected, environment) {
  const entries = new Map();
  const queue = [];
  const deps = new Map();
  const issues = new Map();

  function ensure(name) {
    if (!entries.has(name)) {
      entries.set(name, { incoming: new Map(), extras: new Set() });
      queue.push(name);
    }
    return entries.get(name);
  }

  roots.forEach(ensure);
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    const node = selected.get(parent);
    if (!node) continue;
    const {extras} = entries.get(parent);
    const children = [];
    for (const raw of node.requires) {
      let req;
      try {
        req = readRequirement(raw, environment, extras);
      } catch (error) {
        issues.set(parent, {status: "pending", detail: raw + " — " + error.message});
        continue;
      }
      if (!req) continue;
      children.push(req);
      const child = ensure(req.name);
      child.incoming.set(parent + "\u0000" + raw, {parent, parentVersion: node.version, ...req});
      for (const extra of req.extras) {
        if (child.extras.has(extra)) continue;
        child.extras.add(extra);
        if (selected.has(req.name)) queue.push(req.name);
      }
    }
    deps.set(parent, children);
  }
  return {entries, deps, issues};
}

const meets = (version, incoming) => incoming.every(({condition}) => meetsPythonRange(version, condition));

export async function inspectPython(roots, version, progress) {
  const environment = pythonEnvironment(version);
  const indexes = new Map();
  const metadata = new Map();
  let decisions = 0;

  async function search(selected) {
    const graph = dependencyGraph(roots, selected, environment);
    const failure = (name, issue) => ({selected, graph, name, issue});
    const unresolved = [];
    for (const [name, entry] of graph.entries) {
      const node = selected.get(name);
      if (!node) unresolved.push(name);
      else if (!meets(node.version, [...entry.incoming.values()])) {
        return failure(name, {status: "conflict", detail: "選んだ版では依存元の版条件を同時に満たせません。"});
      }
    }
    progress(graph.entries.size - unresolved.length, graph.entries.size);

    if (graph.issues.size) {
      const [name, issue] = graph.issues.entries().next().value;
      return failure(name, issue);
    }
    if (!unresolved.length) return {selected, graph};
    const name = unresolved[0];
    if (++decisions > decisionsLimit || metadata.size >= requestsLimit || graph.entries.size > 256) {
      return failure(name, {status: "pending", limited: true, detail: "組み合わせを確認する探索が上限に達しました。"});
    }
    if (!indexes.has(name)) indexes.set(name, wheelsFor(name, version));
    const index = await indexes.get(name);
    if (!index.wheels) return failure(name, index);
    const incoming = [...graph.entries.get(name).incoming.values()];
    const acceptable = index.wheels.filter((wheel) => meets(wheel.version, incoming));
    if (!acceptable.length) {
      const conflict = incoming.length > 1 &&
        incoming.every((req) => index.wheels.some((wheel) => meets(wheel.version, [req])));
      return failure(name, conflict
        ? {status: "conflict", detail: "対象環境の公開 wheel に、すべての版条件を満たす候補がありません。"}
        : {status: "pending", detail: "対象の Python 版と版条件に合う非撤回の安定版 wheel を確認できません。"});
    }

    let firstFailure;
    // Some releases publish several compatible wheels. Each can carry distinct dependency metadata.
    for (const wheel of acceptable) {
      if (!metadata.has(wheel.url)) {
        if (++decisions > decisionsLimit || metadata.size >= requestsLimit) {
          return failure(name, {status: "pending", limited: true, detail: "候補の Core Metadata を照合する探索が上限に達しました。"});
        }
        metadata.set(wheel.url, wheelMetadata(name, wheel, version));
      }
      const node = await metadata.get(wheel.url);
      const outcome = node.status === "ok"
        ? await search(new Map([...selected, [name, node]]))
        : failure(name, node);
      if (!outcome.issue || outcome.issue.limited || outcome.issue.status === "fetch") return outcome;
      if (!firstFailure || (firstFailure.issue.status === "conflict" && outcome.issue.status !== "conflict")) {
        firstFailure = outcome;
      }
    }
    return firstFailure;
  }

  for (const name of roots) indexes.set(name, wheelsFor(name, version));
  const rootIndexes = await Promise.all(indexes.values());
  const unavailable = rootIndexes.findIndex((index) => index.status);
  const first = unavailable < 0 ? await search(new Map()) : {
    selected: new Map(), graph: dependencyGraph(roots, new Map(), environment),
    name: roots[unavailable], issue: rootIndexes[unavailable],
  };
  const {selected, graph, name: failed, issue} = first;
  const nodes = [...graph.entries].map(([name, entry]) => {
    const {incoming, extras} = entry;
    const node = selected.get(name);
    const parents = [...incoming.values()];
    const result = name === failed ? issue : graph.issues.get(name);
    return {
      name, index: indexUrl(name), ...node, status: result?.status ?? node?.status ?? "pending",
      detail: result?.detail ?? (!node ? "依存の判定を継続できませんでした。" : undefined),
      metadata: result?.metadata ?? node?.metadata,
      relation: roots.includes(name) ? "入力" : parents.some(({parent}) => roots.includes(parent)) ? "直接" : "間接",
      incoming: parents.map((req) => ({...req,
        status: node ? meets(node.version, [req]) ? "ok" : "conflict" : "pending"})),
      extras: [...extras], deps: graph.deps.get(name) ?? [],
    };
  });
  return {nodes, order: [...selected.keys()], ready: !issue, cycles: [], environment};
}
