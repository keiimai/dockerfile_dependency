import { TARGETS } from "./targets.mjs";

const reference = "ca42f2e50641dffb9b837ed25c87e7a187cb153348fba8596acfafa0f83765a5";
const arm64Digests = new Map([
  ["4.5.2", "3d2018093b4a0ff2acd65273082aec00a9d1b2606f0ac73b1beaa25ef37f7157"],
  ["4.5.3", "eb513f694abfd0b4bfe89abafb49c4103a3a8a68216a5b8a607381c197e2a81d"],
  ["4.6.0", "639365d1eb6a68c80c3066c294237890fd7661dc1fd011e399ecba4f9df15c12"],
  ["4.6.1", "1ad536779cc2354f075fd28e9a67dea895b4605def6299a3a81d555a2e4ca925"],
]);

export const VERSIONS = [...arm64Digests.keys()];

const resoluteR = new Map([
  ["4.6.2", "563df7ef8fab73beb884ee5ddcd99c56bf3309d9aa869b2468c7fb5dcf2ef9e9"],
]);

export function rVersions(release) {
  return release === "resolute" ? [...resoluteR.keys()] : VERSIONS;
}

export function selectBase(rVersion, release = "noble") {
  const target = TARGETS[release];
  const tag = "rocker/rstudio:" + rVersion;
  const evidence = "https://hub.docker.com/r/rocker/rstudio/tags?name=" + encodeURIComponent(rVersion);
  const digest = (release === "resolute" ? resoluteR : arm64Digests).get(rVersion);
  const base = {os: target.label, osVersion: target.version, release, platform: "linux/arm64", rVersion, evidence};
  if (digest) {
    return {
      ...base, image: tag + "@sha256:" + (rVersion === "4.5.3" ? reference : digest),
      arm64Manifest: "sha256:" + digest, status: "ok",
      detail: rVersion === "4.5.3" ? "参照プロジェクトと同じ固定イメージ。" : "Rocker の arm64 構成メタデータで確認。",
    };
  }
  const other = release === "noble" ? resoluteR : arm64Digests;
  if (other.has(rVersion)) {
    return {...base, image: null, candidate: tag, status: "conflict",
      detail: "指定した R の固定イメージは " + (release === "noble" ? "Ubuntu 26.04" : "Ubuntu 24.04") + " 向けです。"};
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

export function makeDockerfile(report) {
  if (report.language === "python") return makePythonDockerfile(report);
  const { base, r, apt, requested, startedAt } = report;
  if (base.status !== "ok" || !r.ready || (apt?.plan && apt.plan.status !== "ok") || wrongAptRelease(base, apt)) return "";
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

export const PYTHON_RUNTIME = /^\d+\.\d+(?:\.\d+)?$/;
export const PYTHON_APT = pythonAptPackages("noble");

export function pythonAptPackages(release) {
  return ["ca-certificates", "python3", "python" + TARGETS[release].python, "python3-venv"];
}

function wrongAptRelease(base, apt) {
  return Boolean(apt?.snapshot?.suites && apt.snapshot.suites[0] !== base.release);
}

export function selectPythonBase(requestedVersion, index, release = "noble", apt) {
  const target = TARGETS[release];
  const base = {
    image: target.image, os: target.label, osVersion: target.version, release, platform: "linux/arm64",
    evidence: "https://hub.docker.com/_/ubuntu", requestedVersion,
  };
  const packageName = "python" + target.python;
  if (requestedVersion.split(".").slice(0, 2).join(".") !== target.python) {
    return {...base, status: "pending", detail: "この OS の調査対象は CPython " + target.python + " です。"};
  }
  const pin = apt === undefined ? index?.real.get(packageName)?.[0] : apt?.pins.find(({name}) => name === packageName);
  const version = pin?.version.match(/^(?:\d+:)?(3\.\d+\.\d+)(?:[+~-]|$)/)?.[1];
  if (!version) {
    return {...base, status: "pending", detail: "Ubuntu 索引で採用する Python のパッチ版を確認できません。"};
  }
  if (requestedVersion !== target.python && requestedVersion !== version) {
    return {...base, pythonVersion: version, status: "conflict",
      detail: "指定のパッチ版と、Ubuntu 索引の CPython " + version + " が一致しません。"};
  }
  return {...base, pythonVersion: version, status: "ok",
    detail: "固定 Ubuntu イメージ。CPython " + version + " を Ubuntu 索引で確認。"};
}

function makePythonDockerfile({base, python, apt, requested, startedAt}) {
  if (base.status !== "ok" || !python.ready || apt?.plan?.status !== "ok" ||
      wrongAptRelease(base, apt) || !pythonAptPackages(base.release).every((name) => apt.pins.some((pin) => pin.name === name))) return "";
  const wheels = python.nodes.map(({name, distribution}) =>
    name + " @ " + distribution.url + " --hash=sha256:" + distribution.sha256);
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
    "",
    "ENV VIRTUAL_ENV=/opt/python",
    'ENV PATH="/opt/python/bin:$PATH"',
    "RUN <<'SH'",
    "set -eu",
    'test "$(python3 -c \'import platform; print(platform.python_version())\')" = ' + base.pythonVersion,
    'python3 -m venv "$VIRTUAL_ENV"',
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
