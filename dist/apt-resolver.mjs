import { matches } from "./r-resolver.mjs";

export const APT_NAME = /^[a-z0-9][a-z0-9+.-]*$/;
const aptVersion = /^(?:\d+:)?[0-9][A-Za-z0-9.+~\-]*$/;

function splitVersion(version) {
  const colon = version.indexOf(":");
  const epoch = colon < 0 ? 0n : BigInt(version.slice(0, colon));
  const rest = version.slice(colon + 1);
  const dash = rest.lastIndexOf("-");
  return [epoch, dash < 0 ? rest : rest.slice(0, dash), dash < 0 ? "0" : rest.slice(dash + 1)];
}

const digit = (ch) => ch >= "0" && ch <= "9";

function debOrder(ch) {
  if (ch === "~") return -1;
  if (!ch || digit(ch)) return 0;
  return /[A-Za-z]/.test(ch) ? ch.charCodeAt(0) : ch.charCodeAt(0) + 256;
}

function compareParts(a, b) {
  let left = 0;
  let right = 0;
  while (left < a.length || right < b.length) {
    while ((left < a.length && !digit(a[left])) || (right < b.length && !digit(b[right]))) {
      const difference = debOrder(a[left]) - debOrder(b[right]);
      if (difference) return Math.sign(difference);
      left++;
      right++;
    }
    const x = a.slice(left).match(/^\d+/)?.[0] ?? "";
    const y = b.slice(right).match(/^\d+/)?.[0] ?? "";
    const xNumber = BigInt(x || "0");
    const yNumber = BigInt(y || "0");
    if (xNumber !== yNumber) return xNumber < yNumber ? -1 : 1;
    left += x.length;
    right += y.length;
  }
  return 0;
}

export function compareDebian(left, right) {
  const [leftEpoch, leftUpstream, leftRevision] = splitVersion(left);
  const [rightEpoch, rightUpstream, rightRevision] = splitVersion(right);
  if (leftEpoch !== rightEpoch) return leftEpoch < rightEpoch ? -1 : 1;
  return compareParts(leftUpstream, rightUpstream) || compareParts(leftRevision, rightRevision);
}

function parse(text) {
  const row = text.trim().match(/^([a-z0-9][a-z0-9+.-]*)(?::([a-z0-9-]+))?\s*(?:\((<<|<=|=|>=|>>)\s*((?:\d+:)?[0-9][A-Za-z0-9.+~-]*)\))?$/);
  if (!row) return { text: text.trim(), unsupported: true };
  const [, name, arch, operator, version] = row;
  return { text: text.trim(), name, arch, operator, version };
}

function add(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function parseIndex(payload) {
  if (payload.schema !== 1 || payload.architecture !== "arm64" ||
      !/^\d{8}T\d{6}Z$/.test(payload.snapshot) ||
      payload.base !== "https://snapshot.ubuntu.com/ubuntu/" + payload.snapshot) {
    throw new Error("Ubuntu 索引の形式または対象環境が一致しません");
  }
  const { packages, libraries, ...snapshot } = payload;
  const real = new Map();
  const virtual = new Map();
  const byKey = new Map();
  for (const row of packages) {
    const [name, version, arch, depends, preDepends, provides, multiArch,
      conflicts, breaks, source, suite, component] = row;
    if (!APT_NAME.test(name) || !aptVersion.test(version)) {
      throw new Error("Ubuntu 索引に解釈できないパッケージ名または版があります: " + name + " " + version);
    }
    const key = [name, version, arch].join(":");
    const location = suite + "/" + component;
    if (byKey.has(key)) {
      byKey.get(key).locations.push(location);
      continue;
    }
    const item = { key, name, version, arch, depends, preDepends, provides, multiArch,
      conflicts, breaks, source, locations: [location] };
    byKey.set(key, item);
    add(real, name, item);
    for (const token of provides.split(",").filter(Boolean).map(parse)) {
      if (!token.unsupported && (!token.operator || token.operator === "=")) {
        add(virtual, token.name, { item, version: token.version });
      }
    }
  }
  const byVersion = (left, right) => compareDebian(right.version, left.version);
  for (const versions of real.values()) versions.sort(byVersion);
  return { real, virtual, byKey, libraries, snapshot };
}

let indexPromise;
export function loadAptIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const url = new URL("./data/ubuntu-noble-arm64.json.gz", import.meta.url);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error("Ubuntu 索引 HTTP " + res.status);
      const json = res.body.pipeThrough(new DecompressionStream("gzip"));
      return parseIndex(await new Response(json).json());
    })().catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  return indexPromise;
}

function targetArchitecture(arch) {
  return !arch || ["arm64", "any", "native"].includes(arch);
}

function resolves(token, index) {
  if (token.unsupported || !targetArchitecture(token.arch)) return [];
  const { real, virtual } = index;
  const accepted = (item, version) =>
    (token.arch !== "any" || item.multiArch === "allowed") &&
    (!token.operator || (version && matches(compareDebian(version, token.version), token.operator)));
  return [
    ...(real.get(token.name) ?? []).filter((item) => accepted(item, item.version))
      .map((item) => ({ item: item.key })),
    ...(virtual.get(token.name) ?? []).filter(({item, version}) => accepted(item, version))
      .map(({item, version}) => ({ item: item.key, via: token.name, providedVersion: version ?? null })),
  ];
}

const common = [
  ["(?:lib)?gdal", "libgdal-dev"], ["(?:lib)?geos", "libgeos-dev"],
  ["(?:lib)?proj(?:\\.4)?", "libproj-dev"], ["(?:lib)?sqlite3", "libsqlite3-dev"],
  ["(?:lib)?udunits-?2", "libudunits2-dev"], ["cmake", "cmake"],
  ["openssl", "libssl-dev"], ["abseil", "libabsl-dev"], ["libxml2", "libxml2-dev"],
  ["zlib", "zlib1g-dev"], ["libpng", "libpng-dev"], ["libjpeg", "libjpeg-dev"],
  ["libtiff", "libtiff-dev"], ["libgit2", "libgit2-dev"], ["libpq", "libpq-dev"],
  ["libicu", "libicu-dev"], ["cairo", "libcairo2-dev"], ["fontconfig", "libfontconfig1-dev"],
  ["freetype2?", "libfreetype-dev"], ["harfbuzz", "libharfbuzz-dev"], ["fribidi", "libfribidi-dev"],
  ["netcdf", "libnetcdf-dev"], ["hdf5", "libhdf5-dev"], ["pkg-config", "pkg-config"], ["ninja", "ninja-build"],
].map(([term, name]) => ({
  exact: new RegExp("^" + term + "$", "i"), advisory: new RegExp("\\b" + term + "\\b", "i"), name,
}));

function guessRequirement(text, index) {
  const match = text.match(/^([A-Za-z0-9.+-]+)\s*(?:\(?\s*(>=|<=|==|>|<|=)\s*(\d+(?:[.-]\d+)+)\s*\)?)?$/);
  if (match) {
    const [, term, operator, version] = match;
    const rule = common.find((entry) => entry.exact.test(term));
    if (rule) return { names: [rule.name], operator, version, auto: true };
    if (/^libcurl$/i.test(term)) {
      return { names: ["libcurl4-openssl-dev", "libcurl4-gnutls-dev"], operator, version };
    }
  }
  const explicit = [...text.matchAll(/\blib[a-z0-9+.-]+-dev\b/g)].map((match) => match[0]);
  const advisory = common.filter((rule) => rule.advisory.test(text)).map((rule) => rule.name);
  const exactIndex = APT_NAME.test(text) && index.real.has(text) ? [text] : [];
  return { names: [...new Set([...explicit, ...advisory, ...exactIndex])] };
}

function directEvidence(rNodes, explicit, index, required) {
  const evidence = [];
  const libraries = new Map();
  for (const [filename, owners] of Object.entries(index.libraries)) {
    const stem = filename.replace(/\.so(?:\..*)?$/, "");
    add(libraries, stem, { filename, owners });
  }
  for (const r of rNodes) {
    const system = r.system ?? "";
    const conditional = /\b(optional|alternatively|alternative|either|or|if|depending|recommended)\b/i.test(system);
    for (const text of system.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean)) {
      const guess = guessRequirement(text, index);
      evidence.push({ rPackage: r.name, kind: "SystemRequirements", text, ...guess, auto: guess.auto && !conditional });
    }
    for (const text of r.externalRequirements ?? []) {
      const guess = guessRequirement(text, index);
      evidence.push({rPackage: r.name, kind: "Requires-External", text, ...guess, auto: false});
    }
    const hints = (r.sysreqHint ?? "").split(/\s+/).filter(Boolean);
    for (const name of new Set(hints.filter((hint) => APT_NAME.test(hint)))) {
      evidence.push({ rPackage: r.name, kind: "Config/pak/sysreqs", text: name, names: [name] });
    }
    for (const lib of r.shlibs ?? []) {
      const files = lib.shlib.includes(".so")
        ? [{ filename: lib.shlib, owners: index.libraries[lib.shlib] ?? [] }]
        : libraries.get(lib.shlib) ?? [];
      const names = [...new Set(files.flatMap((file) => file.owners).filter((name) => index.real.has(name)))];
      const text = lib.shlib + "（観測先 " + (r.buildDistro ?? "不明") + "、報告上の提供元 " + (lib.provider ?? "不明") + "）";
      evidence.push({ rPackage: r.name, kind: "R-universe の共有ライブラリ報告 + Ubuntu Contents", text, library: lib, files, names });
    }
  }
  for (const name of required) evidence.push({kind: "実行環境", text: name, names: [name], auto: true});
  for (const name of explicit) evidence.push({ kind: "入力", text: name, names: [name], auto: true });
  return evidence;
}

function groups(field, text, index) {
  return text.split(",").filter((term) => term.trim()).map((term) => {
    const alternatives = term.split("|").map((part) => {
      const token = parse(part);
      return { ...token, candidates: resolves(token, index) };
    });
    return { field, text: term.trim(), alternatives, pending: alternatives.some(({unsupported}) => unsupported) };
  });
}

function impossibleBranches(nodes) {
  const parents = new Map();
  const remaining = new Map();
  const impossible = new Set();
  const queue = [];
  function reject(key) {
    if (impossible.has(key)) return;
    impossible.add(key);
    queue.push(key);
  }
  for (const node of nodes.values()) {
    for (const constraint of node.constraints) {
      const keys = new Set(constraint.alternatives.flatMap(({candidates}) => candidates.map(({item}) => item)));
      if (!keys.size) reject(node.key);
      remaining.set(constraint, keys.size);
      for (const key of keys) add(parents, key, { parent: node.key, constraint });
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const {parent, constraint} of parents.get(queue[i]) ?? []) {
      const count = remaining.get(constraint) - 1;
      remaining.set(constraint, count);
      if (count === 0) reject(parent);
    }
  }
  return impossible;
}

function packageExclusions(nodes, index) {
  const excludes = new Map();
  const uncertain = new Set();
  for (const node of nodes.values()) {
    for (const [field, value] of [["Conflicts", node.conflicts], ["Breaks", node.breaks]]) {
      for (const term of value.split(",").filter(Boolean)) {
        const token = parse(term);
        if (token.unsupported) uncertain.add(node.key);
        for (const {item} of resolves(token, index)) {
          if (item === node.key || !nodes.has(item)) continue;
          const text = node.name + " " + node.version + " の " + field + "「" + token.text + "」";
          add(excludes, node.key, {item, text});
          add(excludes, item, {item: node.key, text});
        }
      }
    }
  }
  return {excludes, uncertain};
}

function findCombination(roots, nodes, impossible, index) {
  if (!roots.size) return {status: "ok", selection: new Map()};
  const {excludes, uncertain} = packageExclusions(nodes, index);
  const describe = (key) => {
    const {name, version} = nodes.get(key);
    return name + " " + version;
  };
  const dependencies = new Map();
  for (const node of nodes.values()) {
    dependencies.set(node.key, node.constraints.map(({field, text, alternatives}) => ({
      label: describe(node.key) + " の " + field + "「" + text + "」",
      options: [...new Set(alternatives.flatMap(({candidates}) => candidates.map(({item}) => item)))],
      unknown: alternatives.some(({arch, unsupported, candidates}) =>
        unsupported || (targetArchitecture(arch) && !candidates.length)),
    })));
  }

  function searchPlan(relaxed) {
    const required = [...roots].map(([name, options]) => ({label: "固定候補「" + name + "」", options}));
    const selection = new Map();
    const chosenKeys = new Map();
    let failure;
    let work = 0;
    let limited = false;
    const unavailable = (key) => !relaxed && (impossible.has(key) || uncertain.has(key));
    const conflict = (key) => excludes.get(key)?.find(({item}) => chosenKeys.has(item));

    // Choose one version per package. Each dependency group needs just one of its alternatives.
    function visit() {
      let next;
      let choices;
      for (const requirement of required) {
        work += 1 + requirement.options.length;
        if (work > 4_000_000 || selection.size > 800) {
          limited = true;
          return false;
        }
        if ((relaxed && requirement.unknown) || requirement.options.some((key) => chosenKeys.has(key))) continue;
        const available = requirement.options.filter((key) =>
          !unavailable(key) && !selection.has(nodes.get(key).name) && !conflict(key));
        if (!available.length) {
          failure = [requirement.label];
          for (const key of requirement.options.slice(0, 3)) {
            const previous = selection.get(nodes.get(key).name);
            const rule = conflict(key);
            if (previous) {
              failure.push(describe(key) + " と " + describe(previous) +
                " は同時に選べません（" + chosenKeys.get(previous) + "）。");
            } else if (rule) {
              failure.push(describe(key) + " と " + describe(rule.item) + " が競合します（" + rule.text + "）。");
            }
          }
          return false;
        }
        if (!choices || available.length < choices.length) {
          next = requirement;
          choices = available;
        }
      }
      if (!next) return true;
      for (const key of choices) {
        const {name} = nodes.get(key);
        const count = required.length;
        selection.set(name, key);
        chosenKeys.set(key, next.label);
        required.push(...dependencies.get(key));
        if (visit()) return true;
        required.length = count;
        chosenKeys.delete(key);
        selection.delete(name);
        if (limited) break;
      }
      return false;
    }

    return visit() ? {selection} : {limited, detail: failure};
  }

  const strict = searchPlan(false);
  if (strict.selection) return {status: "ok", selection: strict.selection};
  const relaxed = strict.limited ? {} : searchPlan(true);
  if (strict.limited || relaxed.limited) {
    return {status: "pending", text: "APT の固定候補を同時に確認する探索が上限に達しました。"};
  }
  if (relaxed.selection) {
    return {status: "pending", text: "APT の固定候補は、索引で確認できない依存を調べる必要があります。", detail: strict.detail};
  }
  return {
    status: "conflict",
    text: "Ubuntu 索引上で APT の固定候補を同時に満たす組み合わせがありません。",
    detail: relaxed.detail ?? strict.detail,
  };
}

export function inspectApt(rNodes, explicit, index, required = []) {
  const evidence = directEvidence(rNodes, explicit, index, required);
  const queued = new Set();
  const queue = [];
  function visit(key) {
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(index.byKey.get(key));
  }

  for (const row of evidence) {
    row.available = row.names.flatMap((name) => {
      const real = index.real.get(name);
      const versions = (real ?? []).filter((item) => !row.operator ||
        matches(compareDebian(splitVersion(item.version)[1], row.version), row.operator));
      return real ? versions.map((item) => ({ item: item.key })) : resolves(parse(name), index);
    });
    row.available.forEach(({item}) => visit(item));
    const nameCount = new Set(row.available.map(({item}) => index.byKey.get(item).name)).size;
    row.status = !nameCount ? "pending" : nameCount > 1 ? "alternative" :
      row.auto && index.real.has(row.names[0]) ? "ok" : "review";
  }

  const nodes = new Map();
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const constraints = [
      ...groups("Pre-Depends", item.preDepends, index), ...groups("Depends", item.depends, index),
    ];
    constraints.flatMap((row) => row.alternatives).flatMap((alt) => alt.candidates)
      .forEach(({item}) => visit(item));
    nodes.set(item.key, { ...item, constraints });
  }

  const impossible = impossibleBranches(nodes);
  const roots = new Map();
  const issues = [];
  for (const row of evidence) {
    if (!row.auto || !index.real.has(row.names[0])) continue;
    const choices = row.available.map(({item}) => item);
    if (!choices.some((key) => !impossible.has(key))) row.status = "pending";
    const name = row.names[0];
    const previous = roots.get(name);
    roots.set(name, previous ? previous.filter((key) => choices.includes(key)) : choices);
  }

  for (const [name, choices] of roots) {
    if (choices.some((key) => !impossible.has(key))) continue;
    issues.push({ status: "pending", text: name + " の指定条件を同時に満たす版を索引で確認できません。" });
    roots.delete(name);
  }

  const {selection, ...plan} = findCombination(roots, nodes, impossible, index);
  if (plan.status !== "ok") issues.unshift(plan);
  const pins = new Map();
  if (selection) {
    for (const name of roots.keys()) {
      const {version, key, locations} = nodes.get(selection.get(name));
      pins.set(key, {name, version, key, locations});
    }
  }
  for (const row of evidence) {
    row.included = row.status === "ok" && row.available.some(({item}) => pins.has(item));
  }
  const direct = new Set(evidence.flatMap((row) => row.available.map(({item}) => item)));
  const records = [...nodes.values()].map((node) => ({
    ...node, relation: direct.has(node.key) ? "候補元" : "依存先",
    baseState: "導入済みか未確認", status: impossible.has(node.key) ? "pending" : "ok",
    constraints: node.constraints.map((constraint) => {
      const available = new Set(constraint.alternatives.flatMap(({candidates}) =>
        candidates.filter(({item}) => !impossible.has(item)).map(({item}) => nodes.get(item).name)));
      return { ...constraint, status: !available.size || constraint.pending ? "pending" :
        available.size > 1 ? "alternative" : "ok" };
    }),
  }));
  return { snapshot: index.snapshot, evidence, records, pins: [...pins.values()], plan, issues };
}
