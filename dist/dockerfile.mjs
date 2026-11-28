import { TARGETS } from "./targets.mjs?v=cpython-source-1";

import catalog from "./runtime-catalog.mjs?v=cpython-source-1";

export const VERSIONS = rVersions("noble");

export function rVersions(release) {
  return Object.keys(catalog[release].r).sort((left, right) => left.localeCompare(right, "en", {numeric: true}));
}

export function selectBase(rVersion, release = "noble") {
  const target = TARGETS[release];
  const tag = "rocker/rstudio:" + rVersion;
  const evidence = "https://hub.docker.com/r/rocker/rstudio/tags?name=" + encodeURIComponent(rVersion);
  const verified = catalog[release].r[rVersion];
  const base = {os: target.label, osVersion: target.version, release, platform: "linux/arm64", rVersion, evidence};
  if (verified) {
    return {
      ...base, image: tag + "@" + (verified.digest ?? verified.arm64),
      arm64Manifest: verified.arm64, status: "ok",
      detail: "Rocker の arm64 構成メタデータで確認。",
    };
  }
  const other = Object.keys(TARGETS).find((candidate) => catalog[candidate].r[rVersion]);
  if (other) {
    return {...base, image: null, candidate: tag, status: "conflict",
      detail: "指定した R の固定イメージは " + TARGETS[other].label + " 向けです。"};
  }
  return {...base, image: null, candidate: tag, status: "pending",
    detail: "この R 版の " + target.label + " / arm64 イメージを確認できません。R の依存調査は続行します。"};
}

function aptLayer(apt, bootstrapCertificates = false) {
  // The minimal Ubuntu image may not have a CA bundle. Use the signed stock archive to obtain it.
  const certificates = bootstrapCertificates ? [
    "work=$(mktemp -d)",
    'trap \'rm -rf "$work"\' EXIT',
    'ca_file=/etc/ssl/certs/ca-certificates.crt',
    'if [ ! -s "$ca_file" ]; then',
    '  apt-get -o APT::Update::Error-Mode=any update',
    '  (cd "$work"; apt-get download ca-certificates; dpkg-deb -x ca-certificates*.deb .)',
    '  ca_file="$work/snapshot-ca.pem"',
    '  find "$work/usr/share/ca-certificates" -name "*.crt" -exec cat {} + > "$ca_file"',
    '  test -s "$ca_file"',
    'fi',
  ] : [];
  const caOption = bootstrapCertificates ? '-o Acquire::https::CaInfo="$ca_file" ' : '';
  if (!apt?.pins.length) return ["", "# Ubuntu パッケージの追加は調査記録を見て判断してください。"];
  return ["", "# 直接の APT 要件を索引上の版で固定。間接依存の選択は同じスナップショットで APT が行います。",
    "RUN <<'SH'", "set -eu", "export DEBIAN_FRONTEND=noninteractive",
    ...certificates,
    "cat > /tmp/demo-snapshot.list <<'APT'",
    ...apt.snapshot.suites.map((suite) =>
      "deb [arch=arm64 check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] " +
      apt.snapshot.base + "/ " + suite + " " + apt.snapshot.components.join(" ")),
    "APT",
    'apt_snapshot() { apt-get -o Dir::Etc::sourcelist=/tmp/demo-snapshot.list -o Dir::Etc::sourceparts=- ' + caOption + ' "$@"; }',
    "apt_snapshot -o APT::Update::Error-Mode=any update",
    "apt_snapshot install -y --no-install-recommends \\",
    ...apt.pins.map(({name, version}, i) =>
      "  '" + name + "=" + version + "'" + (i < apt.pins.length - 1 ? " \\" : "")),
    "rm -f /tmp/demo-snapshot.list",
    "rm -rf /var/lib/apt/lists/*",
    "SH"];
}

export function dockerfileBlockers({language, base, r, python, apt, ubuntuRequested}) {
  const reasons = [];
  const isPython = language === "python";
  const runtime = isPython ? python : r;
  if (base.status !== "ok") reasons.push(base.detail);
  if (!runtime.ready) {
    const problems = (runtime.nodes ?? []).filter((node) =>
      (node.status !== "ok" && node.status !== "unresolved") || node.conditionStatus);
    for (const node of problems.slice(0, 3)) {
      reasons.push((isPython ? "Python " : "R ") + node.name + " — " +
        (node.conditionDetail ?? node.detail ?? "依存関係を確定できません。"));
    }
    if (!problems.length || problems.length > 3) reasons.push("依存一覧で未確定の項目を確認してください。");
  }
  if (!apt && ubuntuRequested?.length) reasons.push("Ubuntu 索引が利用できず、指定した Ubuntu パッケージを確認できません。");
  if (apt?.plan && apt.plan.status !== "ok") {
    const issues = apt.issues?.slice(0, 3).map(({text}) => text);
    reasons.push(...(issues?.length ? issues : [apt.plan.text ?? "Ubuntu の必須要件を確定できません。"]));
  }
  if (wrongAptRelease(base, apt)) reasons.push("Ubuntu の対象リリースと APT 索引が一致しません。");
  if (!isPython || base.status !== "ok" || (apt?.plan && apt.plan.status !== "ok")) return reasons;

  const pinned = new Set(apt?.pins?.map(({name}) => name));
  const source = base.runtimeMethod === "source";
  const required = source ? pythonBuildPackages : pythonAptPackages(base.release);
  const runtimeMatches = source
    ? validPythonSource(base.pythonSource, base.pythonVersion)
    : pythonRuntimeFromApt(base.release, undefined, apt) === base.pythonVersion;
  const investigated = python.environment?.python_full_version;
  if (!apt?.plan || !runtimeMatches || (investigated && investigated !== base.pythonVersion) ||
      !required.every((name) => pinned.has(name))) {
    reasons.push("調査に使った CPython " + base.pythonVersion + " の実行に必要な Ubuntu パッケージを同時に固定できません。");
  }
  return reasons;
}

export function makeDockerfile(report) {
  if (dockerfileBlockers(report).length) return "";
  if (report.language === "python") return makePythonDockerfile(report);
  const { base, r, apt, requested, startedAt } = report;
  const nl = "\n";
  const lines = [
    "# syntax=docker/dockerfile:1",
    "# 依存メタデータによる調査結果から生成した参考例",
    "# 調査開始: " + startedAt,
    "# 入力 R パッケージ: " + requested.join(", "),
    "# 対象: R " + base.rVersion + " / " + base.os + " / linux/arm64",
    "# buildx を使う場合は --platform=linux/arm64 を指定します。",
    "# APT の候補・未解決項目は調査記録を参照してください。",
    "FROM " + base.image,
    "USER root",
    "SHELL [\"/bin/sh\", \"-c\"]",
    "",
    "RUN <<'SH'",
    "set -eu",
    ". /etc/os-release",
    'test "$ID:$VERSION_ID" = ubuntu:' + base.osVersion,
    'test "$(dpkg --print-architecture)" = arm64',
    'test "$(Rscript --vanilla -e \'cat(as.character(getRversion()))\')" = ' + base.rVersion,
    "SH",
  ];
  lines.push(...aptLayer(apt));
  if (!r.order.length) return lines.join(nl) + nl;
  const nodes = new Map(r.nodes.map((node) => [node.name, node]));
  lines.push(
    "",
    "# 版付きの CRAN ソースを依存順に導入。移動済みなら同じ版を CRAN Archive から取得。",
    "# 配布物の DESCRIPTION を、導入直前に名前・版・依存フィールドと照合します。",
    "ENV R_LIBS=/opt/demo-r-library",
    "RUN <<'SH'",
    "set -eu",
    'mkdir -p "$R_LIBS"',
    "work=$(mktemp -d)",
    'trap \'rm -rf "$work"\' EXIT',
    "install_cran() {",
    "  name=$1",
    "  version=$2",
    "  current=$3",
    "  archive=$4",
    "  expected=$5",
    '  tarball="$work/$name.tar.gz"',
    '  if ! curl -fsSL --retry 2 "$current" -o "$tarball"; then',
    '    curl -fsSL --retry 2 "$archive" -o "$tarball"',
    "  fi",
    '  tar -xOzf "$tarball" "$name/DESCRIPTION" > "$work/DESCRIPTION"',
    "  Rscript --vanilla -e '",
    "    a <- commandArgs(TRUE)",
    "    d <- read.dcf(a[1])[1, ]",
    "    stopifnot(identical(unname(d[[\"Package\"]]), a[2]), identical(unname(d[[\"Version\"]]), a[3]))",
    "    hard <- intersect(c(\"Depends\", \"Imports\", \"LinkingTo\"), names(d))",
    "    tokens <- unlist(lapply(hard, function(field) {",
    "      values <- trimws(strsplit(d[[field]], \",\", fixed=TRUE)[[1]])",
    "      values <- gsub(\"[[:space:]]+\", \"\", values[nzchar(values)])",
    "      paste0(field, \":\", values)",
    "    }))",
    "    stopifnot(setequal(tokens, strsplit(a[4], \"|\", fixed=TRUE)[[1]]))",
    '  \' "$work/DESCRIPTION" "$name" "$version" "$expected"',
    '  R CMD INSTALL --library="$R_LIBS" "$tarball"',
    '  rm -f "$tarball"',
    "}",
  );
  for (const name of r.order) {
    const node = nodes.get(name);
    const { current, archive } = node.distribution;
    const requirements = node.deps.map(({role, name, operator, version}) =>
      role + ":" + name + (operator ? "(" + operator + version + ")" : "")).join("|");
    const args = [name, node.version, current, archive, requirements].map((value) => "'" + value + "'");
    lines.push("install_cran " + args.join(" "));
  }
  lines.push("SH", "");
  return lines.join(nl);
}

export const PYTHON_RUNTIME = /^3\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/;
export const PYTHON_APT = pythonAptPackages("noble");

export function pythonAptPackages(release, minor = TARGETS[release].python) {
  return ["ca-certificates", "python3", "python" + minor, "python3-venv"];
}

export function upstreamPythonVersion(pin) {
  return pin?.version.match(/^(?:\d+:)?(3\.\d+\.\d+)(?:[+~-]|$)/)?.[1];
}

function wrongAptRelease(base, apt) {
  return Boolean(apt?.snapshot?.suites && apt.snapshot.suites[0] !== base.release);
}

export const pythonBuildPackages = [
  "ca-certificates", "curl", "build-essential", "pkg-config", "libssl-dev", "zlib1g-dev",
  "libbz2-dev", "liblzma-dev", "libsqlite3-dev", "libreadline-dev", "libffi-dev", "libncurses-dev",
  "libgdbm-dev", "libgdbm-compat-dev", "libexpat1-dev", "uuid-dev", "libzstd-dev",
];

function sourceUrl(version) {
  return "https://www.python.org/ftp/python/" + version + "/Python-" + version + ".tgz";
}

function validPythonSource(source, version) {
  return Boolean(source) && source.version === version && source.url === sourceUrl(version) &&
    /^[a-f0-9]{64}$/.test(source.sha256) && source.sha256 === catalog.pythonSources?.[version];
}

export function pythonRuntimeChoice(requestedVersion, release) {
  const defaultPatch = catalog[release].python;
  if (requestedVersion === TARGETS[release].python || requestedVersion === defaultPatch) {
    return {method: "apt", version: defaultPatch};
  }
  const minor = requestedVersion.split(".").slice(0, 2).join(".");
  const version = requestedVersion === minor ? catalog.pythonSeries[minor] ?? (minor + ".0") : requestedVersion;
  const sha256 = catalog.pythonSources?.[version];
  const source = sha256 ? {version, url: sourceUrl(version), sha256} : null;
  return {method: "source", version, source: validPythonSource(source, version) ? source : null};
}

export function selectPythonBase(requestedVersion, index, release = "noble", apt) {
  const target = TARGETS[release];
  const runtime = pythonRuntimeChoice(requestedVersion, release);
  const base = {
    image: target.image, os: target.label, osVersion: target.version, release, platform: "linux/arm64",
    evidence: "https://hub.docker.com/_/ubuntu", requestedVersion, runtimeMethod: runtime.method,
  };
  if (runtime.method === "source" && !runtime.source) {
    return {...base, status: "pending", detail: "CPython " + runtime.version + " の公式ソースの SHA-256 を確認できません。"};
  }
  if (!index) {
    return {...base, status: "pending", detail: "Ubuntu の公式 APT 索引を取得できないため、Python の実行環境を固定できません。"};
  }
  if (apt?.plan?.status && apt.plan.status !== "ok") {
    return {...base, status: apt.plan.status, detail: "Python の実行環境に必要な Ubuntu パッケージを固定できません。"};
  }
  if (runtime.method === "source") {
    return {
      ...base, status: "ok", pythonVersion: runtime.version, pythonSource: runtime.source,
      detail: "固定 Ubuntu イメージに CPython " + runtime.version + " を Python.org の公式ソースからビルドします。",
    };
  }
  const version = pythonRuntimeFromApt(release, index, apt);
  if (!version) {
    return {...base, status: "pending", detail: "Ubuntu の公式 APT 索引で Python の実行環境を固定できません。"};
  }
  if (requestedVersion !== target.python && requestedVersion !== version) {
    return {...base, pythonVersion: version, status: "conflict",
      detail: "指定の CPython " + requestedVersion + " と、Ubuntu の公式 APT 索引で固定できる CPython " + version + " が一致しません。"};
  }
  return {...base, pythonVersion: version, status: "ok",
    detail: "固定 Ubuntu イメージ。CPython " + version + " を Ubuntu 索引で確認。"};
}

export function pythonRuntimeFromApt(release, index, apt) {
  const packageName = "python" + TARGETS[release].python;
  const pin = apt === undefined ? index?.real.get(packageName)?.[0] : apt?.pins.find(({name}) => name === packageName);
  return upstreamPythonVersion(pin);
}

function pythonWheelArtifacts(python) {
  return python.nodes.map(({name, version, distribution}) => ({
    name, version, url: distribution.url, sha256: distribution.sha256,
  }));
}

export function dockerfileHashes({base, language, python}) {
  const [reference, digest] = base.image.split("@");
  return {
    baseImage: {reference, digest},
    pythonSource: language === "python" ? base.pythonSource ?? null : null,
    wheels: language === "python" ? pythonWheelArtifacts(python) : [],
  };
}

function cpythonLayer({url, sha256, version}) {
  return [
    "",
    "# 指定した CPython の公式ソースを固定。Ubuntu のシステム Python とは別の場所に導入します。",
    "RUN <<'SH'",
    "set -eu",
    "work=$(mktemp -d)",
    'trap \'rm -rf "$work"\' EXIT',
    'tarball="$work/Python.tgz"',
    "curl -fsSL --retry 2 '" + url + "' -o \"$tarball\"",
    "printf '%s  %s\\n' '" + sha256 + "' \"$tarball\" | sha256sum --check -",
    'tar -xzf "$tarball" -C "$work"',
    'cd "$work/Python-' + version + '"',
    "./configure --prefix=/opt/cpython --with-ensurepip=no",
    "jobs=$(nproc)",
    'if [ "$jobs" -gt 6 ]; then jobs=6; fi',
    'make -j"$jobs"',
    "make install",
    "/opt/cpython/bin/python3 -c 'import ssl, sqlite3, zlib, bz2, lzma, ctypes, readline, venv'",
    "SH",
  ];
}

function makePythonDockerfile({base, python, apt, requested, startedAt}) {
  const interpreter = base.runtimeMethod === "source" ? "/opt/cpython/bin/python3" : "python3";
  const wheels = pythonWheelArtifacts(python).map(({name, url, sha256}) =>
    name + " @ " + url + " --hash=sha256:" + sha256);
  return [
    "# syntax=docker/dockerfile:1",
    "# 依存メタデータによる調査結果から生成した参考例",
    "# 調査開始: " + startedAt,
    "# 入力 Python パッケージ: " + requested.join(", "),
    "# 対象: CPython " + base.pythonVersion + " / " + base.os + " / linux/arm64",
    "# buildx を使う場合は --platform=linux/arm64 を指定します。",
    "FROM " + base.image,
    "USER root",
    "SHELL [\"/bin/sh\", \"-c\"]",
    "",
    "RUN <<'SH'",
    "set -eu",
    ". /etc/os-release",
    'test "$ID:$VERSION_ID" = ubuntu:' + base.osVersion,
    'test "$(dpkg --print-architecture)" = arm64',
    "SH",
    ...aptLayer(apt, true),
    ...(base.pythonSource ? cpythonLayer(base.pythonSource) : []),
    "",
    "ENV VIRTUAL_ENV=/opt/python",
    'ENV PATH="/opt/python/bin:$PATH"',
    "RUN <<'SH'",
    "set -eu",
    'test "$(' + interpreter + ' -c \'import platform; print(platform.python_version())\')" = ' + base.pythonVersion,
    interpreter + ' -m venv "$VIRTUAL_ENV"',
    "work=$(mktemp -d)",
    'trap \'rm -rf "$work"\' EXIT',
    'cat > "$work/requirements.txt" <<\'WHEELS\'',
    ...wheels,
    "WHEELS",
    'python -m pip --disable-pip-version-check install --no-index --require-hashes --only-binary=:all: -r "$work/requirements.txt"',
    "python -m pip check",
    "SH",
    "",
  ].join("\n");
}
