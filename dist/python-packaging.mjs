import { compare, explain, satisfies, valid, validRange } from "./vendor/pep440/index.js";

export { compare, explain, valid };
export const PYTHON_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
export const normalizePythonName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

function rangeText(text) {
  return text.trim().replace(/,$/, "");
}

export function validPythonRange(text) {
  return rangeText(text) === "" || Boolean(validRange(rangeText(text)));
}

export function meetsPythonRange(version, text) {
  return satisfies(version, rangeText(text), {prereleases: true});
}

const markerFields = new Set([
  "os_name", "sys_platform", "platform_machine", "platform_python_implementation",
  "platform_release", "platform_system", "platform_version", "python_version",
  "python_full_version", "implementation_name", "implementation_version", "extra", "extras", "dependency_groups",
]);
const versionFields = new Set(["python_version", "python_full_version", "implementation_version"]);

export function pythonEnvironment(version) {
  return {
    os_name: "posix", sys_platform: "linux", platform_machine: "aarch64",
    platform_python_implementation: "CPython", platform_system: "Linux",
    python_version: version.split(".").slice(0, 2).join("."), python_full_version: version,
    implementation_name: "cpython", implementation_version: version, extra: "",
  };
}

function evaluateMarker(text, environment, extra) {
  if (!text) return true;
  const parser = /\s*(not\s+in\b|in\b|and\b|or\b|===|~=|==|!=|<=|>=|<|>|[()]|"[^"\\]*"|'[^'\\]*'|[A-Za-z_]\w*)/gy;
  const tokens = [];
  const expr = text.trim();
  while (parser.lastIndex < expr.length) {
    const token = parser.exec(expr);
    if (!token) throw new Error("環境マーカーを解釈できません");
    tokens.push(token[1].replace(/^not\s+in$/, "not in"));
  }
  let i = 0;

  function operand() {
    const raw = tokens[i++];
    if (raw?.startsWith('"') || raw?.startsWith("'")) return {value: raw.slice(1, -1)};
    if (!markerFields.has(raw)) throw new Error("環境マーカーの変数を解釈できません");
    return {field: raw, value: raw === "extra" ? extra : environment[raw]};
  }

  function term() {
    if (tokens[i] === "(") {
      i++;
      const value = either();
      if (tokens[i++] !== ")") throw new Error("環境マーカーの括弧を解釈できません");
      return value;
    }
    const left = operand();
    const op = tokens[i++];
    const right = operand();
    if (!["===","~=","==","!=","<=",">=","<",">","in","not in"].includes(op)) {
      throw new Error("環境マーカーの演算子を解釈できません");
    }
    if (left.value === undefined || right.value === undefined) return null;
    const field = left.field ?? right.field;
    let a = left.value;
    let b = right.value;
    if (field === "extra") {
      a = normalizePythonName(a);
      b = normalizePythonName(b);
    }
    if (versionFields.has(field) && valid(a) && validPythonRange(op + b)) return meetsPythonRange(a, op + b);
    const operators = {
      "==": () => a === b, "!=": () => a !== b, "<": () => a < b, ">": () => a > b,
      "<=": () => a <= b, ">=": () => a >= b, in: () => b.includes(a), "not in": () => !b.includes(a),
    };
    return operators[op]?.() ?? null;
  }

  function both() {
    let result = term();
    while (tokens[i] === "and") {
      i++;
      const next = term();
      result = result === false || next === false ? false : result === null || next === null ? null : true;
    }
    return result;
  }

  function either() {
    let result = both();
    while (tokens[i] === "or") {
      i++;
      const next = both();
      result = result === true || next === true ? true : result === null || next === null ? null : false;
    }
    return result;
  }
  const result = either();
  if (i !== tokens.length) throw new Error("環境マーカーを最後まで解釈できません");
  return result;
}

export function readRequirement(raw, environment, extras) {
  const separator = raw.indexOf(";");
  const spec = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  const marker = separator < 0 ? "" : raw.slice(separator + 1).trim();
  if (separator >= 0 && !marker) throw new Error("環境マーカーが空です");
  const results = [...new Set(["", ...extras])].map((extra) => evaluateMarker(marker, environment, extra));
  if (!results.includes(true)) {
    if (results.includes(null)) throw new Error("対象環境で環境マーカーを判定できません");
    return null;
  }
  const match = spec.match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\s*\[([^\]]+)\])?\s*(.*)$/);
  if (!match) throw new Error("依存の構文を解釈できません");
  const [, name, requestedExtras, tail] = match;
  const condition = rangeText(tail.startsWith("(") && tail.endsWith(")") ? tail.slice(1, -1) : tail);
  const extraNames = requestedExtras ? requestedExtras.split(",").map((value) => value.trim()) : [];
  if (!extraNames.every((value) => PYTHON_NAME.test(value)) || !validPythonRange(condition)) {
    throw new Error("版条件または取得元を解釈できません");
  }
  return {name: normalizePythonName(name), extras: extraNames.map(normalizePythonName), condition, raw, marker, role: "Requires-Dist"};
}

function platformRank(tag) {
  if (tag === "any") return 1;
  if (tag === "linux_aarch64") return 2;
  if (tag === "manylinux2014_aarch64") return 117;
  const match = tag.match(/^manylinux_2_(\d+)_aarch64$/);
  return match && Number(match[1]) >= 17 && Number(match[1]) <= 39 ? 100 + Number(match[1]) : 0;
}

export function wheelCandidate(file, project, pythonVersion) {
  const filename = file.filename;
  if (typeof filename !== "string" || !/^[A-Za-z0-9_.+!-]+\.whl$/.test(filename) || file.yanked !== false) return null;
  const parts = filename.slice(0, -4).split("-");
  if (parts.length !== 5 && (parts.length !== 6 || !/^\d\w*$/.test(parts[2]))) return null;
  const [name, version] = parts;
  const [python, abi, platform] = parts.slice(-3);
  if (normalizePythonName(name) !== project || !valid(version) || explain(version).is_prerelease) return null;
  if (file["requires-python"] && (!validPythonRange(file["requires-python"]) ||
      !meetsPythonRange(pythonVersion, file["requires-python"]))) return null;

  const minor = Number(pythonVersion.split(".")[1]);
  const cpTag = "cp3" + minor;
  let abiRank = 0;
  for (const tag of python.split(".")) {
    if (tag === cpTag && abi.split(".").includes(cpTag)) abiRank = Math.max(abiRank, 300);
    if (/^cp3\d+$/.test(tag) && Number(tag.slice(3)) >= 2 && Number(tag.slice(3)) <= minor &&
        abi.split(".").includes("abi3")) abiRank = Math.max(abiRank, 200 + Number(tag.slice(3)));
    if (abi.split(".").includes("none") && (tag === "py3" || tag === cpTag ||
        (/^py3\d+$/.test(tag) && Number(tag.slice(3)) <= minor))) abiRank = Math.max(abiRank, 10);
  }
  const platformMatch = Math.max(...platform.split(".").map(platformRank));
  if (!abiRank || !platformMatch) return null;

  const {url, hashes} = file;
  if (typeof url !== "string" || !/^https:\/\/files\.pythonhosted\.org\/packages\/[A-Za-z0-9._%+!\/-]+$/.test(url) ||
      !url.endsWith("/" + filename) || !/^[a-f0-9]{64}$/i.test(hashes?.sha256 ?? "")) return null;
  const metadata = file["core-metadata"] ?? file["data-dist-info-metadata"];
  return {filename, url, version, sha256: hashes.sha256.toLowerCase(), metadata, rank: abiRank + platformMatch,
    requiresPython: file["requires-python"] ?? null};
}

export function readWheelHeaders(text) {
  const headers = new Map();
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0];
  let values;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && values) {
      values[values.length - 1] += " " + line.trim();
      continue;
    }
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!headers.has(key)) headers.set(key, []);
    values = headers.get(key);
    values.push(match[2]);
  }
  return headers;
}
