import catalog from "./runtime-catalog.mjs?v=verification-1";
import { TARGETS } from "./targets.mjs?v=verification-1";
import { APT_NAME, inspectApt, loadAptIndex } from "./apt-resolver.mjs?v=verification-1";
import { dockerfileBlockers, dockerfileHashes, makeDockerfile, pythonRuntimeChoice, selectBase, rVersions, PYTHON_RUNTIME } from "./dockerfile.mjs?v=verification-1";
import { PYTHON_NAME, normalizePythonName } from "./python-packaging.mjs?v=verification-1";
import { applyPythonIndex, inspectPythonTarget, pythonVersionChoices } from "./python-investigation.mjs?v=verification-1";
import { PYPI } from "./python-resolver.mjs?v=verification-1";
import { CRAN, CRAN_HISTORY, PACKAGE_NAME, R_VERSION, UNIVERSE, inspectR, pinRArchive } from "./r-resolver.mjs?v=verification-1";

import { minimumVersions, supportedRuntime } from "./runtime-policy.mjs";
import { buildEvidence } from "./build-evidence.mjs";

const $ = (id) => document.getElementById(id);
const form = $("investigate");
const submit = $("submit");
const language = $("language");
const osSelect = $("target-os");
const runtimeVersion = $("r-version");
const customVersion = $("custom-version");
const packages = $("packages");
const aptPackages = $("apt-packages");
const results = $("results");
const dockerButton = $("download-dockerfile");
const reportButton = $("download-report");
const labels = {
  ok: "確認", pending: "判定保留", review: "要確認", alternative: "複数候補",
  fetch: "取得失敗", missing: "見つからない", conflict: "競合", neutral: "未調査",
  source: "ソースビルドが必要", "no-wheel": "対応 wheel なし", unresolved: "経路未確定",
  candidate: "候補あり", covered: "APT 計画に候補あり", reference: "参考", outside: "対象外",
  optional: "任意・条件付き", bundled: "ソースに同梱",
};
const scope = "公開メタデータの調査。Docker ビルド、パッケージの読み込み、共有ライブラリの動作確認は範囲外。";
const modes = {
  r: {label: "R", name: PACKAGE_NAME, version: R_VERSION,
    example: ["ggplot2", "sf"], aptHint: "libgdal-dev, libudunits2-dev"},
  python: {label: "Python", name: PYTHON_NAME, version: PYTHON_RUNTIME,
    example: ["requests", "numpy"], aptHint: "例  libpq-dev, libxml2-dev"},
};
const drafts = new Map();
const versionDrafts = new Map();
let release = osSelect.value;
const draftKey = () => release + "/" + selectedLanguage;
let selectedLanguage = language.value;
let latest;
let generation = 0;
let presentationRevision = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(url, label) {
  const node = element("a", label);
  node.href = url;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

function badge(state, text = labels[state]) {
  return element("span", text, "badge " + state);
}

function setStatus(state, text) {
  const node = $("run-status");
  node.className = "badge " + state;
  node.textContent = text;
}

function details(title, ...children) {
  const box = element("details");
  box.append(element("summary", title), ...children);
  return box;
}

function list(values) {
  const node = element("ul");
  for (const value of values) {
    const li = element("li");
    li.append(value);
    node.append(li);
  }
  return node;
}

function table(headings, rows, label) {
  const scroll = element("div", null, "table-scroll");
  const grid = element("table");
  grid.setAttribute("aria-label", label);
  const head = grid.createTHead().insertRow();
  for (const heading of headings) {
    const th = element("th", heading);
    th.scope = "col";
    head.append(th);
  }
  const body = grid.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const parts of cells) {
      row.insertCell().append(...parts);
    }
  }
  scroll.append(grid);
  return scroll;
}

function section(title, id) {
  const block = element("section", null, "result-section");
  block.setAttribute("aria-labelledby", id);
  const heading = element("h3", title);
  heading.id = id;
  block.append(heading);
  return block;
}

function conditionText({name, operator, version, raw}) {
  if (raw) return raw;
  return operator ? name + " (" + operator + " " + version + ")" : name;
}

function runtimeTable(result, id, label) {
  const rows = result.nodes.map((node) => {
    const evaluation = [badge(node.status === "ok" ? node.conditionStatus ?? node.status : node.status)];
    if (node.detail) evaluation.push(element("p", node.detail));
    if (node.conditionStatus) {
      if (node.status !== "ok") evaluation.push(badge(node.conditionStatus));
      evaluation.push(element("p", node.conditionDetail));
    }
    const sources = [];
    if (node.index) {
      const index = element("p");
      index.append(link(node.index, "PyPI の索引"));
      sources.push(index);
    }
    if (node.metadata) {
      const metadata = element("p");
      metadata.append(link(node.metadata, node.distribution?.repository === "archive" ? "旧版の DESCRIPTION" : "公開メタデータ"));
      sources.push(metadata);
    }
    if (node.distribution) {
      const artifact = element("p");
      if (id === "python") {
        artifact.append(link(node.distribution.url, "PyPI の wheel"));
        sources.push(artifact, details("wheel の SHA-256", element("code", node.distribution.sha256)));
      } else {
        const {url, archive, repository, sha256} = node.distribution;
        const title = repository === "archive" ? "CRAN Archive の配布物" :
          repository === "r-universe" ? "R-universe のソース配布物" : "CRAN のソース配布物";
        artifact.append(link(url, title));
        if (repository === "cran") artifact.append(" · ", link(archive, "CRAN Archive"));
        sources.push(artifact);
        if (sha256) sources.push(details("配布物の SHA-256", element("code", sha256, "docker-digest")));
      }
    }
    if (node.sourceDistribution) {
      const source = element("p");
      source.append(link(node.sourceDistribution.url, "PyPI のソース配布物 " + node.sourceDistribution.version));
      sources.push(source);
    }
    if (node.requiresPython) sources.push(element("p", "Requires-Python " + node.requiresPython));
    if (node.source) sources.push(element("p", node.source));
    if (node.incoming.length) {
      const conditions = node.incoming.map((dep) => {
        const line = element("span");
        line.append(dep.parent + " " + dep.parentVersion + " の " + dep.role + " — " + conditionText(dep) + " ", badge(dep.status));
        return line;
      });
      sources.push(details("依存元と版条件", list(conditions)));
    }
    if (node.system) sources.push(details("SystemRequirements", element("p", node.system)));
    return [
      [element("code", node.name), element("p", node.relation, "muted")],
      [element("code", node.version ?? "—")], evaluation, sources,
    ];
  });
  return table(["パッケージ", "候補版", "判定", "根拠"], rows, label);
}

function runtimeSection(result, id, mode) {
  const title = mode.label + " の依存";
  const block = section(title, id + "-title");
  block.append(element("p", result.nodes.length + " 件。依存元と版条件は各行で確認できます。", "hint"));
  const search = result.archiveSearch;
  if (search?.packages) {
    const adopted = result.nodes.filter((node) => node.distribution?.repository === "archive").length;
    block.append(element("p", "CRAN の旧版を " + search.packages + " パッケージで検索し、" +
      search.candidates + " 候補を照合しました。採用した旧版は " + adopted + " 件です。", "hint"));
    if (search.limited) block.append(element("p", "旧版の探索上限に達したため、他の組み合わせは未確認です。", "hint"));
    if (search.unavailable.length) block.append(details("取得できなかった旧版情報",
      list(search.unavailable.map(({name, reason}) => name + " — " + reason))));
  }
  block.append(runtimeTable(result, id, title + "一覧"));
  if (result.individual?.length) {
    const partial = details("個別の入力で確認できた依存",
      element("p", "各パッケージを単独で調査した結果です。全体の組み合わせは未確定です。", "hint"));
    for (const result of result.individual) {
      partial.append(details(result.root + " の依存 " + result.nodes.length + " 件",
        runtimeTable(result, id, result.root + " の依存一覧")));
    }
    block.append(partial);
  }
  if (result.cycles.length) {
    const message = element("p");
    message.append(badge("conflict"), " 循環依存が見つかりました — " + result.cycles.join(", "));
    block.append(message);
  }
  return block;
}

function aptEvidenceGroups(evidence, records) {
  const groups = new Map();
  for (const row of evidence) {
    const names = [...row.names].sort();
    const key = row.coveredBy.length ? records.get(row.coveredBy[0]).name :
      names.join("・") || row.library?.shlib || row.text;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function aptEvidence(groups, records, label) {
  const rows = groups.map((evidence) => {
    const representative = evidence.find(({included}) => included) ?? evidence.find(({required}) => required) ?? evidence[0];
    const packages = [...new Set(evidence.map(({rPackage}) => rPackage).filter(Boolean))];
    const conditions = [...new Set(evidence.filter(({operator, required}) => operator && required)
      .map(({operator, version}) => operator + " " + version))];
    const caption = [...new Set(representative.names)].join("、") || representative.library?.shlib || representative.text;
    const matched = [...new Set(evidence.flatMap(({coveredBy}) => coveredBy))];
    const alternatives = [...new Set(evidence.flatMap(({alternatives}) => alternatives ?? []))];
    const candidates = new Map();
    for (const row of evidence) {
      for (const {item} of row.available) {
        const record = records.get(item);
        if (!candidates.has(record.name) || matched.includes(item)) candidates.set(record.name, record.version);
      }
    }
    const chosen = matched.map((key) => records.get(key)).map(({name, version}) => name + " " + version);
    const available = chosen.length ? chosen : [...candidates].map(([name, version]) => name + " " + version);
    const detailsList = evidence.map((row) => {
      const entry = element("span");
      entry.append((row.rPackage ? row.rPackage + " · " : "") + row.kind + " — " + row.text);
      if (row.note) entry.append(" " + row.note);
      if (row.source) entry.append(" ", link(row.source, "出典"));
      if (row.files?.length) {
        entry.append(details("Contents のファイル", list(row.files.map(({filename, owners}) => filename + " — " + owners.join(", ")))));
      }
      return entry;
    });
    const status = evidence.find(({status}) => ["missing", "conflict", "pending", "review"].includes(status))?.status
      ?? representative.status;
    const source = [element("p", caption), element("p", packages.join("、"), "muted"),
      details("根拠 " + evidence.length + " 件", list(detailsList))];
    const choices = [element("p", available.join("、") ||
      (representative.status === "bundled" ? "R ソース配布物" : "索引から該当する提供元を特定できません"))];
    if (conditions.length) choices.push(element("p", "上流版 " + conditions.join("、"), "muted"));
    if (alternatives.length > 1) choices.push(element("p", "提供候補 " + alternatives.join("、"), "muted"));
    if (candidates.size > available.length) {
      choices.push(details("索引上の候補 " + candidates.size + " 件", list([...candidates].map(([name, version]) => name + " " + version))));
    }
    return [source, choices, [badge(status)]];
  });
  return table(["要件", "Ubuntu パッケージ候補", "判定"], rows, label);
}

function graphTable(records) {
  const perPage = 20;
  let page = 0;
  const ordered = [...records.values()].sort((a, b) =>
    Number(b.relation === "候補元") - Number(a.relation === "候補元") || a.name.localeCompare(b.name));
  const pages = Math.ceil(ordered.length / perPage);
  const target = element("div");
  const count = element("span", null, "hint");
  const previous = element("button", "前へ", "secondary");
  const next = element("button", "次へ", "secondary");
  previous.type = next.type = "button";
  const formatOption = ({item, via, providedVersion}) => {
    const candidate = records.get(item);
    return candidate.name + " " + candidate.version + " (" + candidate.arch + ")" +
      (via ? " — 仮想 " + via + (providedVersion ? " " + providedVersion : "") : "") +
      (candidate.status === "pending" ? " · 依存判定保留" : "");
  };
  function renderPage() {
    const rows = ordered.slice(page * perPage, (page + 1) * perPage).map((record) => {
      const constraints = record.constraints.map((constraint) => {
        const line = element("span");
        line.append(constraint.field + " — " + constraint.text + " ", badge(constraint.status));
        const alternatives = constraint.alternatives.map((alt) => {
          if (alt.unsupported) return alt.text + " — 形式を解釈できません";
          return alt.text + " — " + (alt.candidates.length ? alt.candidates.map(formatOption).join("、") : "条件に合う候補なし");
        });
        line.append(list(alternatives));
        return line;
      });
      const info = [
        element("p", record.locations.join("、"), "muted"),
        element("p", record.baseState, "muted"),
      ];
      if (record.provides) info.push(details("Provides", element("p", record.provides)));
      if (record.conflicts || record.breaks) {
        const fields = [];
        if (record.conflicts) fields.push(element("p", "Conflicts — " + record.conflicts));
        if (record.breaks) fields.push(element("p", "Breaks — " + record.breaks));
        info.push(details("Conflicts / Breaks", ...fields));
      }
      if (constraints.length) info.push(details("依存条件 " + constraints.length + " 件", list(constraints)));
      return [
        [element("code", record.name), element("p", record.relation, "muted")],
        [element("code", record.version), element("p", record.arch, "muted")],
        [badge(record.status)], info,
      ];
    });
    target.replaceChildren(table(["パッケージ", "版", "判定", "索引と依存条件"], rows, "Ubuntu の依存一覧"));
    count.textContent = (page + 1) + " / " + pages + " ページ";
    previous.disabled = page <= 0;
    next.disabled = page >= pages - 1;
  }
  previous.addEventListener("click", () => { page--; renderPage(); });
  next.addEventListener("click", () => { page++; renderPage(); });
  const navigation = element("div", null, "pager");
  navigation.append(previous, count, next);
  renderPage();
  return details("APT の依存一覧 " + ordered.length + " 件（版別）", navigation, target);
}

function aptSection(apt, error, loading) {
  const block = section("Ubuntu の依存", "apt-title");
  if (loading) { block.append(element("p", "Ubuntu 索引を取得中です。")); return block; }
  if (error) {
    block.append(badge("fetch"), element("p", error, "hint"));
    return block;
  }
  const {snapshot, evidence, pins, issues} = apt;
  block.append(element("p", "公式索引 " + snapshot.snapshot + " · " + snapshot.architecture, "hint"));
  const sources = snapshot.sources.map(({kind, url}) => link(url, kind + " · " + new URL(url).pathname.split("/dists/")[1]));
  block.append(details("索引の取得元と日時", element("p", "取得日時 " + snapshot.fetchedAt), list(sources)));
  block.append(element("p", "ベースイメージへの導入状況は未確認です。共有ライブラリの候補は別のビルド環境での報告を含みます。", "hint"));
  const records = new Map(apt.records.map((node) => [node.key, node]));
  const groups = aptEvidenceGroups(evidence, records);
  const actionable = groups.filter((group) => group.some((row) => row.required || row.status === "review"));
  const reference = groups.filter((group) => !actionable.includes(group));
  if (actionable.length) block.append(aptEvidence(actionable, records, "Ubuntu の必須要件と確認事項"));
  else block.append(element("p", "追加で固定する必須の Ubuntu パッケージはありません。", "hint"));
  if (reference.length) block.append(details("参考・任意の要件 " + reference.length + " 件",
    aptEvidence(reference, records, "Ubuntu の参考・任意の要件")));
  for (const issue of issues) {
    const note = element("p");
    note.append(badge(issue.status), " " + issue.text);
    block.append(note);
    if (issue.detail?.length) block.append(list(issue.detail));
  }
  if (pins.length) {
    block.append(details("Dockerfile の APT 固定 " + pins.length + " 件",
      list(pins.map(({name, version}) => name + "=" + version))));
  }
  if (records.size) block.append(graphTable(records));
  return block;
}

function revisions(report) {
  const { apt, aptError, language } = report;
  const reviews = language === "r" ? [
    "R は CRAN 公開版の候補を優先します。条件を満たさない場合は CRAN の公開履歴ミラーから旧版の DESCRIPTION を調べます。",
    "R の同梱標準パッケージは R 本体と同じ版として扱います。推奨パッケージは公開版を調査します。",
    "Dockerfile は取得元と SHA-256 を固定し、導入前に配布物のハッシュと DESCRIPTION の名前・版・必須依存を照合します。",
    "SystemRequirements の未対応表記、複数提供元、他環境の共有ライブラリ報告を根拠にした項目は手動で確認してください。",
  ] : [
    "調査した CPython 版と対象 OS に対して Requires-Python、環境マーカー、wheel のタグを照合します。",
    "非撤回の安定版 wheel と公開の Core Metadata を使います。ソース配布物からのビルドと、wheel が使う共有ライブラリの実測は調査範囲外です。",
    "Requires-External が公開されている場合は Ubuntu の候補を表示します。必要に応じて Ubuntu パッケージを直接指定できます。",
    "Dockerfile は仮想環境を作り、各 wheel の URL と SHA-256 を指定して pip で導入し、依存を照合します。",
  ];
  reviews.push("APT の固定候補と必須依存の組み合わせを Ubuntu 索引上で確認します。ベースの導入状態と実際の APT による導入は未確認です。");
  if (aptError && language === "r") {
    reviews.unshift("Ubuntu の依存を索引で照合できませんでした。");
  }
  return reviews;
}

function renderDockerfileHashes(hashes) {
  const block = $("dockerfile-hashes");
  const body = $("dockerfile-hash-list");
  block.hidden = !hashes;
  body.replaceChildren();
  if (!hashes) return;

  const base = element("p");
  base.append("ベースイメージ ", element("code", hashes.baseImage.reference),
    element("code", hashes.baseImage.digest, "docker-digest"));
  body.append(base);
  if (hashes.pythonSource) {
    const source = element("p");
    source.append(link(hashes.pythonSource.url, "CPython " + hashes.pythonSource.version + " の公式ソース"),
      element("code", "sha256:" + hashes.pythonSource.sha256, "docker-digest"));
    body.append(source);
  }
  for (const [label, artifacts] of [["R ソース配布物", hashes.rSources], ["Python wheel", hashes.wheels]]) {
    if (!artifacts.length) continue;
    const entries = element("dl");
    for (const {name, version, sha256, url} of artifacts) {
      const digest = element("dd");
      digest.append(element("code", "sha256:" + sha256, "docker-digest"));
      const artifact = element("dt");
      artifact.append(link(url, name + " " + version));
      entries.append(artifact, digest);
    }
    const hashesList = details(label + " " + artifacts.length + " 件", entries);
    hashesList.open = artifacts.length <= 8;
    body.append(hashesList);
  }
}

function rSourcesWithoutHash(report) {
  if (report.language !== "r" || !report.r.ready) return [];
  return report.r.nodes.filter(({distribution}) => distribution && !distribution.sha256);
}

function renderRPinning(report) {
  const missing = rSourcesWithoutHash(report);
  $("r-source-pinning").hidden = !missing.length;
  $("r-pinning-files").replaceChildren(list(missing.map(({distribution}) =>
    link(distribution.url, distribution.file))));
}

function generate(report) {
  report.dockerfileBlockers = dockerfileBlockers(report);
  if (report.aptLoading) report.dockerfileBlockers = ["Ubuntu 索引を照合中です。"];
  const dockerfile = report.aptLoading ? "" : makeDockerfile(report);
  const sources = report[report.language].nodes.filter((node) => node.distribution);
  report.hashCoverage = {identified: sources.length, pinned: sources.filter((n) => n.distribution.sha256).length,
    downloaded: sources.filter((n) => ["downloaded-artifact", "local-file", "cran-archive-catalog"].includes(n.distribution.hashEvidence?.method)).length};
  const digest = report.base.image?.split("@")[1];
  const imageRepository = report.language === "r" ? "rocker/rstudio" : "library/ubuntu";
  report.baseHashEvidence = digest ? {reference:report.base.image,
    source:"https://registry-1.docker.io/v2/" + imageRepository + "/manifests/" + digest,
    method:"catalog-image-digest", catalogReadAt:report.startedAt} : null;
  report.dockerfileHashes = dockerfile ? dockerfileHashes(report) : null;
  return dockerfile;
}

function render(report, dockerfile) {
  const {base, apt, aptError, requested, finishedAt, language, requestedVersion} = report;
  const mode = modes[language];
  const result = report[language];
  const targetVersion = language === "r" ? report.rVersion : report.pythonVersion;
  const meta = $("result-meta");
  const conditions = element("p");
  conditions.append(element("strong", "対象"), " " + mode.label + " " + targetVersion + " / " + report.os + " / linux/arm64");
  const rInput = element("p");
  rInput.append(element("strong", "入力"), " " + requested.join("、"));
  if (language === "python" && requestedVersion !== targetVersion) rInput.append("（指定の版 " + requestedVersion + "）");
  const baseRow = element("p");
  baseRow.append(element("strong", "ベースイメージ"), " ", element("code", base.image ?? base.candidate), " ",
    badge(base.status), " ", base.detail, " ", link(base.evidence, language === "r" ? "Rocker のタグ" : "Ubuntu イメージ"));
  const time = element("p", new Date(finishedAt ?? report.updatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST");
  meta.replaceChildren(conditions, rInput, baseRow, time);
  const stat = (value, name) => {
    const block = element("div");
    block.append(element("strong", value), element("span", name));
    return block;
  };
  $("result-summary").replaceChildren(
    stat(mode.label + " " + targetVersion, requestedVersion === targetVersion
      ? "調査したバージョン" : "調査したバージョン（指定 " + requestedVersion + "）"),
    stat(String(result.nodes.length), "依存一覧の件数"),
    stat(apt ? String(apt.pins.length) : "—", "Ubuntu の固定件数"),
  );

  const versionNote = $("python-version-note");
  versionNote.textContent = report.pythonVersionNote ?? "";
  if (report.pythonVersionSource) versionNote.append(" ", link(report.pythonVersionSource, "Python.org の公開版一覧"));
  versionNote.hidden = !report.pythonVersionNote;
  renderDockerfileHashes(report.dockerfileHashes);
  const coverage = report.hashCoverage;
  const kind = language === "r" ? "R ソース" : "Python wheel";
  const checks = $("verification-scope");
  const record = report.buildEvidence;
  const build = element("p");
  const when = record?.checkedAt?.slice(0,10) ?? record?.date;
  build.textContent = !record ? "この条件と一致する実ビルドの記録はありません。" :
    record.scope === "python-runtime" ? "CPython " + record.version + " のビルド・起動を確認（" + when + "）。入力した Python パッケージの導入は未検証です。" :
    "同じ Dockerfile の実ビルド" + (record.status === "passed" ? "成功" : "失敗") + "（" + when + "）。" + record.detail;
  if (record?.source) build.append(" ", link(record.source, "GitHub Actions の実行記録"));
  checks.replaceChildren(element("p", kind + "の SHA-256 は特定した配布物 " + coverage.identified + " 件中 " +
    coverage.pinned + " 件で確認。配布物の実ファイルから計算した値は " + coverage.downloaded + " 件です。"), build);
  if (language === "python") {
    const runtime = pythonRuntimeChoice(requestedVersion, report.osRelease);
    report.runtimeHash = runtime.source ?? null;
    const method = runtime.source?.hashEvidence?.method;
    const methods = {"python-release-sha256":"Python.org のリリースページ掲載値", "sigstore-declared-digest":"公式 Sigstore バンドルの記載値",
      "artifact-sha256-after-md5":"公式 MD5 と照合した配布物から計算", "previous-catalog":"既存カタログの値"};
    checks.append(element("p", runtime.source ? "CPython 本体の SHA-256 は" + methods[method] + "です。" :
      runtime.method === "apt" ? "CPython 本体は Ubuntu の署名付き APT リポジトリから導入します。" :
      "CPython 本体の SHA-256 は未収録です。"));
  }
  if (apt?.snapshot.sources.some((source) => source.signature)) {
    checks.append(element("p", "Ubuntu 索引は、公式鍵で検証した Release の SHA-256 と照合済みです。"));
  }
  $("apt-retry").hidden = !aptError || Boolean(report.aptLoading);
  renderRPinning(report);
  $("docker-preview").hidden = !dockerfile;
  $("docker-preview").open = false;
  $("docker-code").textContent = dockerfile;
  dockerButton.disabled = !dockerfile;
  reportButton.disabled = false;
  const openApt = apt?.evidence.some((row) => row.status === "review");
  const exportNote = $("export-note");
  if (report.aptLoading) {
    exportNote.textContent = "Ubuntu 索引の照合が終わると、Dockerfile の生成可否を表示します。";
  } else if (!dockerfile) {
    exportNote.replaceChildren(element("strong", "Dockerfile を生成できません。"), list(report.dockerfileBlockers));
  } else {
    exportNote.textContent = openApt ? "Ubuntu の要件に用途や提供元を確認できない項目があります。"
      : "参考例です。生成元の根拠と確認事項は調査記録で参照できます。";
  }

  const summaries = section("確認事項", "review-title");
  summaries.append(list(report.notes));
  results.replaceChildren(runtimeSection(result, language, mode), aptSection(apt, aptError, report.aptLoading), summaries);
  $("empty").hidden = true;
  $("active").hidden = false;
  const states = new Set(result.nodes.flatMap(({status, conditionStatus}) => [status, conditionStatus]));
  if (report.aptLoading) setStatus("neutral", "言語の調査完了・Ubuntu 索引を照合中");
  else if (states.has("fetch")) setStatus("fetch", "取得失敗あり");
  else if (!result.ready && (result.archiveSearch?.limited || result.archiveSearch?.unavailable.length)) {
    setStatus("pending", "旧版の探索に未確認あり");
  } else if (states.has("conflict") || base.status === "conflict" || result.cycles.length ||
    apt?.issues.some(({status}) => status === "conflict")) setStatus("conflict", "競合あり");
  else if (states.has("missing") || apt?.issues.some(({status}) => status === "missing")) setStatus("missing", "見つからない項目あり");
  else if (states.has("source")) setStatus("source", "ソースビルドが必要な項目あり");
  else if (states.has("no-wheel")) setStatus("no-wheel", "対応 wheel がない項目あり");
  else if (result.ready && !dockerfile && !aptError && (language === "python" || rSourcesWithoutHash(report).length)) setStatus("review", "調査完了・Dockerfile 生成不可");
  else if (aptError && language === "python") setStatus("fetch", "索引の取得失敗");
  else if (!result.ready || base.status !== "ok" || apt?.plan?.status === "pending") setStatus("pending", "判定保留あり");
  else if (aptError) setStatus("fetch", "索引の取得失敗");
  else if (openApt) setStatus("review", "調査完了・要確認あり");
  else setStatus("ok", "調査完了");
}

function clearResult() {
  generation++;
  setBusy(false);
  latest = undefined;
  dockerButton.disabled = reportButton.disabled = true;
  $("active").hidden = true;
  $("empty").hidden = false;
  $("docker-code").textContent = "";
  $("r-archives").value = "";
  $("r-pin-status").textContent = "";
  results.replaceChildren();
  setStatus("neutral", "未調査");
}

function setBusy(running) {
  submit.disabled = running;
  submit.textContent = running ? "調査中…" : "調査する";
}

function enteredVersion() {
  return (runtimeVersion.value === "custom" ? customVersion.value : runtimeVersion.value).trim();
}

function updateCustomVersion() {
  const custom = runtimeVersion.value === "custom";
  $("custom-version-field").hidden = !custom;
  customVersion.disabled = !custom;
  customVersion.required = custom;
  baseHint();
}

function baseHint() {
  const node = $("base");
  const chosen = enteredVersion();
  if (modes[selectedLanguage].version.test(chosen) && !supportedRuntime(selectedLanguage, chosen)) {
    node.textContent = modes[selectedLanguage].label + " は " + minimumVersions[selectedLanguage] + " 以降が対象です。";
    return;
  }
  if (selectedLanguage === "python") {
    node.textContent = PYTHON_RUNTIME.test(chosen)
      ? "調査に使う版は Python " + pythonRuntimeChoice(chosen, release).version + " です。"
      : "Python 3 の系列またはパッチ版を指定できます。";
    return;
  }
  if (!R_VERSION.test(chosen)) {
    node.textContent = "R の版に応じた Rocker イメージを表示します。";
    return;
  }
  const base = selectBase(chosen, release);
  node.replaceChildren(element("code", (base.image ?? base.candidate).split("@")[0]), base.status === "ok" ? "" : " " + base.detail);
}

function updateLanguageFields(versionValue) {
  const mode = modes[selectedLanguage];
  const [first, second] = mode.example;
  const python = selectedLanguage === "python" ? pythonVersionChoices(release) : null;
  const versions = python ? [python.defaultVersion, ...python.sourceVersions, ...python.investigationOnly] : rVersions(release);
  const version = python?.defaultVersion ?? versions.at(-1);
  $("environment-os").textContent = TARGETS[release].label;
  $("version-label").textContent = mode.label + " のバージョン";
  $("custom-version-label").textContent = "バージョンを入力（" + minimumVersions[selectedLanguage] + " 以降）";
  $("packages-label").textContent = mode.label + " パッケージ名";
  customVersion.pattern = mode.version.source.slice(1, -1);
  customVersion.placeholder = version ? "例  " + (python ? catalog[release].python : version) : "メジャー.マイナー.パッチ";
  packages.placeholder = first + "\n" + second;
  aptPackages.placeholder = mode.aptHint;
  $("language-nav").href = "#" + selectedLanguage + "-title";
  $("language-nav").textContent = mode.label + " の依存";
  const options = versions.map((value) => {
    const option = element("option", value);
    option.value = value;
    return option;
  });
  runtimeVersion.replaceChildren(...options);
  const other = element("option", "その他のバージョン");
  other.value = "custom";
  runtimeVersion.append(other);
  runtimeVersion.value = versions.includes(versionValue) ? versionValue :
    versionValue === undefined && version ? version : "custom";
  customVersion.value = runtimeVersion.value === "custom" ? (versionValue ?? "") : "";
  updateCustomVersion();
}

function names(value) {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function download(filename, type, value) {
  const url = URL.createObjectURL(new Blob([value], {type}));
  const node = element("a");
  node.href = url;
  node.download = filename;
  document.body.append(node);
  node.click();
  node.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

updateLanguageFields();
runtimeVersion.addEventListener("change", updateCustomVersion);
customVersion.addEventListener("input", baseHint);
language.addEventListener("change", () => {
  versionDrafts.set(draftKey(), enteredVersion());
  drafts.set(selectedLanguage, {names: packages.value, apt: aptPackages.value});
  selectedLanguage = language.value;
  const draft = drafts.get(selectedLanguage);
  packages.value = draft?.names ?? "";
  aptPackages.value = draft?.apt ?? "";
  clearResult();
  $("input-error").hidden = true;
  updateLanguageFields(versionDrafts.get(draftKey()));
});
osSelect.addEventListener("change", () => {
  versionDrafts.set(draftKey(), enteredVersion());
  release = osSelect.value;
  clearResult();
  $("input-error").hidden = true;
  updateLanguageFields(versionDrafts.get(draftKey()));
});
form.addEventListener("input", () => {
  clearResult();
  $("input-error").hidden = true;
});
form.addEventListener("invalid", clearResult, true);
dockerButton.addEventListener("click", () => {
  if (latest?.dockerfile) download("Dockerfile", "application/octet-stream", latest.dockerfile);
});
reportButton.addEventListener("click", () => {
  if (latest) download("dependency-report.json", "application/json", JSON.stringify(latest.report, null, 2) + "\n");
});

$("r-archives").addEventListener("change", async (event) => {
  const investigation = latest;
  if (!investigation) return;
  const input = event.currentTarget;
  const fileList = [...input.files];
  input.value = "";
  input.disabled = true;
  const status = $("r-pin-status");
  status.textContent = "配布物の SHA-256 を計算中…";
  const wanted = new Map(rSourcesWithoutHash(investigation.report).map((node) => [node.distribution.file, node]));
  const messages = [];
  try {
    for (const file of fileList) {
      const node = wanted.get(file.name);
      if (!node) {
        messages.push(file.name + " — 照合対象のファイル名と一致しません。");
        continue;
      }
      try {
        const pinned = await pinRArchive(node, file);
        if (latest?.report !== investigation.report) return;
        node.distribution = pinned;
        wanted.delete(file.name);
        messages.push(file.name + " — SHA-256 を記録しました。");
      } catch (error) {
        messages.push(file.name + " — " + error.message);
      }
    }
    if (latest?.report !== investigation.report) return;
    await present(investigation.report, investigation.generation);
    if (latest?.report !== investigation.report) return;
    status.textContent = messages.join(" ");
  } finally {
    input.disabled = false;
  }
});

const requestIndex = (os) => loadAptIndex(os, catalog[os].snapshot)
  .then((index) => ({index}), (error) => ({error: error.message}));

async function present(report, id) {
  if (id !== generation) return;
  const revision = ++presentationRevision;
  report.updatedAt = new Date().toISOString();
  report.finishedAt = report.aptLoading ? null : report.updatedAt;
  report.notes = revisions(report);
  const dockerfile = generate(report);
  const evidence = await buildEvidence(report, dockerfile);
  if (id !== generation || revision !== presentationRevision) return;
  report.buildEvidence = evidence;
  render(report, dockerfile);
  latest = {report, dockerfile, generation:id};
}

async function finishIndex(report, promise, id) {
  const {index, error} = await promise;
  if (id !== generation) return;
  report.aptLoading = false;
  report.aptError = error ?? null;
  if (index && report.language === "python") {
    Object.assign(report, applyPythonIndex({version:report.requestedVersion, release:report.osRelease,
      ubuntuRequested:report.ubuntuRequested, index}, report.python));
  } else if (index) {
    report.apt = inspectApt(report.r.nodes, report.ubuntuRequested, index);
  }
  await present(report, id);
}

$("apt-retry").addEventListener("click", async () => {
  if (!latest || latest.report.aptLoading) return;
  const {report, generation:id} = latest;
  report.aptLoading = true;
  const promise = requestIndex(report.osRelease);
  await present(report, id);
  try { await finishIndex(report, promise, id); }
  catch (error) {
    if (id !== generation) return;
    report.aptLoading = false;
    report.aptError = error.message;
    await present(report, id);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  clearResult();
  const id = selectedLanguage;
  const mode = modes[id];
  const version = enteredVersion();
  const entered = names(packages.value);
  const requested = id === "r" ? entered : [...new Set(entered.map(normalizePythonName))];
  const ubuntuRequested = names(aptPackages.value);
  const invalidNames = entered.filter((name) => !mode.name.test(name));
  const invalidApt = ubuntuRequested.filter((name) => !APT_NAME.test(name));
  const inputError = $("input-error");
  inputError.hidden = true;
  if (mode.version.test(version) && !supportedRuntime(id, version)) {
    inputError.textContent = mode.label + " は " + minimumVersions[id] + " 以降が対象です。";
    inputError.hidden = false;
    return;
  }
  if (!mode.version.test(version) || !requested.length || invalidNames.length || invalidApt.length) {
    inputError.textContent = !mode.version.test(version) ? (id === "python" ? "Python 3" : mode.label) + " のバージョンを指定してください（" + customVersion.placeholder + "）。" :
      !requested.length ? mode.label + " パッケージ名を 1 件以上入力してください。" :
        invalidNames.length ? mode.label + " パッケージ名の形式を確認してください — " + invalidNames.join("、") :
          "Ubuntu パッケージ名の形式を確認してください — " + invalidApt.join("、");
    inputError.hidden = false;
    return;
  }
  const idOfRequest = generation;
  setBusy(true);
  setStatus("neutral", "公開メタデータ取得中");
  try {
    const startedAt = new Date().toISOString();
    const target = TARGETS[release];
    const aptPromise = requestIndex(release);
    const progress = (done, total, phase) => {
      if (idOfRequest !== generation) return;
      const text = phase === "archive" ? "CRAN 旧版の候補を照合中（" + done + " 件）" :
        phase === "hash" ? "R 配布物の SHA-256 を確認中（" + done + " / " + total + "）" :
        mode.label + " メタデータ " + done + " / " + total;
      setStatus("neutral", text);
    };
    const report = {
      schema: 2, apt:null, aptLoading:true, title: "依存メタデータによる調査結果", scope, startedAt, language: id, requestedVersion: version,
      os: target.label, osRelease: release, platform: "linux/arm64", requested, ubuntuRequested,
      catalogSnapshot: catalog[release].snapshot,
    };
    if (id === "r") {
      report.base = selectBase(version, release);
      report.rVersion = version;
      report.r = await inspectR(requested, version, progress);
      report.sources = {rMetadata: UNIVERSE, cranSourceDistribution: CRAN, cranHistoryMirror: CRAN_HISTORY};
    } else {
      Object.assign(report, await inspectPythonTarget({requested, version, ubuntuRequested, release, progress}));
      report.sources = {pythonIndex: PYPI, wheelMetadata: "PyPI Core Metadata"};
    }
    if (idOfRequest !== generation) return;
    await present(report, idOfRequest);
    await finishIndex(report, aptPromise, idOfRequest);
    if (idOfRequest !== generation) return;
    const heading = $("result-title");
    if (heading.getBoundingClientRect().top >= window.innerHeight) heading.focus();
  } catch (error) {
    if (idOfRequest !== generation) return;
    clearResult();
    setStatus("fetch", "調査処理に失敗");
    inputError.textContent = "調査を完了できませんでした — " + error.message;
    inputError.hidden = false;
  } finally {
    if (idOfRequest === generation) setBusy(false);
  }
});
