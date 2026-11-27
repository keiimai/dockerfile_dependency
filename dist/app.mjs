import { APT_NAME, inspectApt, loadAptIndex } from "./apt-resolver.mjs";
import { makeDockerfile, selectBase, selectPythonBase, VERSIONS, PYTHON_APT, PYTHON_RUNTIME } from "./dockerfile.mjs";
import { PYTHON_NAME, normalizePythonName } from "./python-packaging.mjs";
import { PYPI, inspectPython } from "./python-resolver.mjs";
import { CRAN, PACKAGE_NAME, R_VERSION, UNIVERSE, inspectR } from "./r-resolver.mjs";

const $ = (id) => document.getElementById(id);
const form = $("investigate");
const submit = $("submit");
const language = $("language");
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
};
const scope = "公開メタデータの調査。Docker ビルド、パッケージの読み込み、共有ライブラリの動作確認は範囲外。";
const modes = {
  r: {label: "R", name: PACKAGE_NAME, version: R_VERSION, versions: VERSIONS,
    example: ["4.5.3", "ggplot2", "sf"], aptHint: "libgdal-dev, libudunits2-dev"},
  python: {label: "Python", name: PYTHON_NAME, version: PYTHON_RUNTIME, versions: ["3.12"],
    example: ["3.12", "requests", "numpy"], aptHint: "例  libpq-dev, libxml2-dev"},
};
const drafts = new Map();
let selectedLanguage = language.value;
let latest;

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

function runtimeSection(result, id, mode) {
  const title = mode.label + " の依存";
  const block = section(title, id + "-title");
  block.append(element("p", result.nodes.length + " 件。依存元と版条件は各行で確認できます。", "hint"));
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
      metadata.append(link(node.metadata, "公開メタデータ"));
      sources.push(metadata);
    }
    if (node.distribution) {
      const artifact = element("p");
      if (id === "python") {
        artifact.append(link(node.distribution.url, "PyPI の wheel"));
        sources.push(artifact, details("wheel の SHA-256", element("code", node.distribution.sha256)));
      } else {
        artifact.append(link(node.distribution.current, "CRAN 配布物"), " · ", link(node.distribution.archive, "Archive"));
        sources.push(artifact);
      }
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
  block.append(table(["パッケージ", "候補版", "判定", "根拠"], rows, title + "一覧"));
  if (result.cycles.length) {
    const message = element("p");
    message.append(badge("conflict"), " 循環依存が見つかりました — " + result.cycles.join(", "));
    block.append(message);
  }
  return block;
}

function aptEvidence(apt, records) {
  const pinned = new Set(apt.pins.map(({key}) => key));
  const rows = apt.evidence.map((row) => {
    const source = [element("p", row.rPackage ? row.rPackage + " · " + row.kind : row.kind),
      element("p", row.text, "muted")];
    const optionNames = new Map();
    for (const option of row.available) {
      const record = records.get(option.item);
      if (!optionNames.has(record.name) || (row.included && pinned.has(option.item))) {
        optionNames.set(record.name, record.version);
      }
    }
    const candidate = optionNames.size ? [...optionNames].map(([name, version]) => name + " " + version).join("、") :
      row.names.length ? row.names.join("、") + "（条件に合う索引項目なし）" : "提供元を特定できません";
    const choices = [element("p", candidate)];
    if (row.operator) choices.push(element("p", "上流版 " + row.operator + " " + row.version, "muted"));
    if (row.files?.length) {
      choices.push(details("Contents のファイル", list(row.files.map(({filename, owners}) => filename + " — " + owners.join(", ")))));
    }
    const state = [badge(row.status), element("p", row.included ? "Dockerfile の直接指定に採用" : "この根拠からの自動追加なし", "muted")];
    return [source, choices, state];
  });
  return table(["根拠", "Ubuntu パッケージ候補", "判定"], rows, "Ubuntu パッケージの候補と根拠");
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

function aptSection(apt, error) {
  const block = section("Ubuntu の依存", "apt-title");
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
  if (evidence.length) block.append(aptEvidence(apt, records));
  else block.append(element("p", "今回取得した R メタデータに Ubuntu パッケージを特定する手掛かりはありません。", "hint"));
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
  const { base, apt, aptError, language } = report;
  const mode = modes[language];
  const reviews = language === "r" ? [
    "R は CRAN 公開版 API の取得時点の候補を対象とします。旧版の組み合わせは調査対象外です。",
    "R の同梱標準パッケージは R 本体と同じ版として扱います。推奨パッケージは公開版を調査します。",
    "ソース URL を版で固定し、生成した Dockerfile は導入前に DESCRIPTION の名前・版・必須依存を照合します。",
    "SystemRequirements の未対応表記、複数提供元、他環境の共有ライブラリ報告を根拠にした項目は手動で確認してください。",
  ] : [
    "対象は CPython 3.12、Ubuntu 24.04、arm64 です。Requires-Python、環境マーカー、wheel のタグを照合します。",
    "非撤回の安定版 wheel と公開の Core Metadata を使います。ソース配布物からのビルドと、wheel が使う共有ライブラリの実測は調査範囲外です。",
    "Requires-External が公開されている場合は Ubuntu の候補を表示します。必要に応じて Ubuntu パッケージを直接指定できます。",
    "Dockerfile は仮想環境を作り、各 wheel の URL と SHA-256 を指定して pip で導入し、依存を照合します。",
  ];
  reviews.push("APT の固定候補と必須依存の組み合わせを Ubuntu 索引上で確認します。ベースの導入状態と実際の APT による導入は未確認です。");
  if (base.status !== "ok") reviews.unshift(base.detail);
  if (!report[language].ready) reviews.unshift(mode.label + " の依存に未解決項目があります。Dockerfile は生成できません。");
  if (apt?.plan?.status === "conflict") reviews.unshift("APT の固定候補が競合するため、Dockerfile は生成できません。");
  if (apt?.plan?.status === "pending") reviews.unshift("APT の固定候補を同時に確認できないため、Dockerfile の生成を保留します。");
  if (aptError) reviews.unshift(language === "r"
    ? "Ubuntu 索引の取得に失敗しました。APT の設定は Dockerfile に入りません。"
    : "Ubuntu 索引の取得に失敗しました。Python の実行環境を固定できません。");
  if (apt?.evidence.some((row) => row.status === "pending")) {
    reviews.unshift("索引で提供元や条件に合う Ubuntu パッケージを確認できなかった項目があります。");
  }
  return reviews;
}

function render(report, dockerfile) {
  const {base, apt, aptError, requested, finishedAt, language, requestedVersion} = report;
  const mode = modes[language];
  const result = report[language];
  const targetVersion = language === "r" ? report.rVersion : base.pythonVersion ?? requestedVersion;
  const meta = $("result-meta");
  const conditions = element("p");
  conditions.append(element("strong", "対象"), " " + mode.label + " " + targetVersion + " / Ubuntu 24.04 / linux/arm64");
  const rInput = element("p");
  rInput.append(element("strong", "入力"), " " + requested.join("、"));
  if (language === "python" && requestedVersion !== targetVersion) rInput.append("（指定の版 " + requestedVersion + "）");
  const baseRow = element("p");
  baseRow.append(element("strong", "ベースイメージ"), " ", element("code", base.image ?? base.candidate), " ",
    badge(base.status), " ", base.detail, " ", link(base.evidence, language === "r" ? "Rocker のタグ" : "Ubuntu イメージ"));
  const time = element("p", new Date(finishedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST");
  meta.replaceChildren(conditions, rInput, baseRow, time);
  const stat = (value, name) => {
    const block = element("div");
    block.append(element("strong", value), element("span", name));
    return block;
  };
  $("result-summary").replaceChildren(
    stat(mode.label + " " + targetVersion, "対象バージョン"),
    stat(String(result.nodes.length), "依存一覧の件数"),
    stat(apt ? String(apt.pins.length) : "—", "Ubuntu の固定件数"),
  );

  $("docker-preview").hidden = !dockerfile;
  $("docker-preview").open = false;
  $("docker-code").textContent = dockerfile;
  dockerButton.disabled = !dockerfile;
  reportButton.disabled = false;
  const openApt = aptError || apt?.evidence.some((row) => row.status !== "ok") ||
    apt?.issues.length;
  $("export-note").textContent = !dockerfile ? (
    apt?.plan?.status === "conflict" ? "APT の固定候補が競合しています。調査記録で根拠を確認してください。" :
    apt?.plan?.status === "pending" ? "APT の組み合わせは判定保留です。調査記録で根拠を確認してください。" :
      "ベースイメージまたは " + mode.label + " の依存に未解決項目があるため、調査記録を確認してください。"
  ) :
    openApt ? "APT の要確認項目があります。調査記録とあわせて使用してください。" :
      "参考例です。生成元の根拠と確認事項は調査記録で参照できます。";

  const summaries = section("確認事項", "review-title");
  summaries.append(list(report.notes));
  results.replaceChildren(runtimeSection(result, language, mode), aptSection(apt, aptError), summaries);
  $("empty").hidden = true;
  $("active").hidden = false;
  const states = new Set(result.nodes.flatMap(({status, conditionStatus}) => [status, conditionStatus]));
  if (states.has("fetch")) setStatus("fetch", "取得失敗あり");
  else if (states.has("conflict") || base.status === "conflict" || result.cycles.length ||
    apt?.issues.some(({status}) => status === "conflict")) setStatus("conflict", "競合あり");
  else if (states.has("missing")) setStatus("missing", "見つからない項目あり");
  else if (aptError && language === "python") setStatus("fetch", "索引の取得失敗");
  else if (!result.ready || base.status !== "ok" || apt?.plan?.status === "pending") setStatus("pending", "判定保留あり");
  else if (aptError) setStatus("fetch", "索引の取得失敗");
  else if (openApt) setStatus("review", "調査完了・要確認あり");
  else setStatus("ok", "調査完了");
}

function clearResult() {
  latest = undefined;
  dockerButton.disabled = reportButton.disabled = true;
  $("active").hidden = true;
  $("empty").hidden = false;
  $("docker-code").textContent = "";
  results.replaceChildren();
  setStatus("neutral", "未調査");
}

function setBusy(running) {
  for (const control of [language, runtimeVersion, packages, aptPackages, submit]) {
    control.disabled = running;
  }
  customVersion.disabled = running || runtimeVersion.value !== "custom";
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
  if (selectedLanguage === "python") {
    const base = selectPythonBase(chosen);
    node.replaceChildren(element("code", base.image.split("@")[0]));
    return;
  }
  if (!R_VERSION.test(chosen)) {
    node.textContent = "R の版に応じた Rocker イメージを表示します。";
    return;
  }
  const base = selectBase(chosen);
  node.replaceChildren(element("code", (base.image ?? base.candidate).split("@")[0]), base.status === "ok" ? "" : " " + base.detail);
}

function updateLanguageFields(versionValue) {
  const mode = modes[selectedLanguage];
  const [version, first, second] = mode.example;
  $("version-label").textContent = mode.label + " のバージョン";
  $("packages-label").textContent = mode.label + " パッケージ名";
  customVersion.pattern = mode.version.source.slice(1, -1);
  customVersion.placeholder = "例  " + version;
  packages.placeholder = first + "\n" + second;
  aptPackages.placeholder = mode.aptHint;
  $("language-nav").href = "#" + selectedLanguage + "-title";
  $("language-nav").textContent = mode.label + " の依存";
  runtimeVersion.replaceChildren(...mode.versions.map((value) => {
    const option = element("option", value);
    option.value = value;
    return option;
  }));
  const other = element("option", "その他のバージョン");
  other.value = "custom";
  runtimeVersion.append(other);
  runtimeVersion.value = mode.versions.includes(versionValue) ? versionValue :
    versionValue === undefined ? version : "custom";
  customVersion.value = runtimeVersion.value === "custom" ? versionValue : "";
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
  drafts.set(selectedLanguage, {version: enteredVersion(), names: packages.value, apt: aptPackages.value});
  selectedLanguage = language.value;
  const draft = drafts.get(selectedLanguage);
  packages.value = draft?.names ?? "";
  aptPackages.value = draft?.apt ?? "";
  clearResult();
  $("input-error").hidden = true;
  updateLanguageFields(draft?.version);
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
  if (!mode.version.test(version) || !requested.length || invalidNames.length || invalidApt.length) {
    inputError.textContent = !mode.version.test(version) ? mode.label + " の版を " + mode.example[0] + " のように入力してください。" :
      !requested.length ? mode.label + " パッケージ名を 1 件以上入力してください。" :
        invalidNames.length ? mode.label + " パッケージ名の形式を確認してください — " + invalidNames.join("、") :
          "Ubuntu パッケージ名の形式を確認してください — " + invalidApt.join("、");
    inputError.hidden = false;
    return;
  }
  setBusy(true);
  setStatus("neutral", "公開メタデータ取得中");
  try {
    const startedAt = new Date().toISOString();
    const aptPromise = loadAptIndex().then((index) => ({index}), (error) => ({error: error.message}));
    const progress = (done, total) => setStatus("neutral", mode.label + " メタデータ " + done + " / " + total);
    const report = {
      schema: 1, title: "依存メタデータによる調査結果", scope, startedAt, language: id, requestedVersion: version,
      os: "Ubuntu 24.04", platform: "linux/arm64", requested, ubuntuRequested,
    };
    if (id === "r") {
      report.base = selectBase(version);
      report.rVersion = version;
      report.r = await inspectR(requested, version, progress);
      setStatus("neutral", "Ubuntu 索引を照合中");
      const {index, error} = await aptPromise;
      report.apt = index ? inspectApt(report.r.nodes, ubuntuRequested, index) : null;
      report.aptError = error ?? null;
      report.sources = {rMetadata: UNIVERSE, cranSourceDistribution: CRAN};
    } else {
      const {index, error} = await aptPromise;
      report.base = selectPythonBase(version, index);
      report.pythonVersion = report.base.pythonVersion ?? null;
      report.python = report.base.status === "ok" ? await inspectPython(requested, report.pythonVersion, progress) : {
        ready: false, order: [], cycles: [], nodes: requested.map((name) =>
          ({name, status: "pending", detail: report.base.detail, relation: "入力", incoming: []})),
      };
      setStatus("neutral", "Ubuntu 索引を照合中");
      report.apt = index ? inspectApt(report.python.nodes, ubuntuRequested, index, PYTHON_APT) : null;
      report.aptError = error ?? null;
      if (report.base.status === "ok" && report.apt?.plan?.status === "ok" &&
          !PYTHON_APT.every((name) => report.apt.pins.some((pin) => pin.name === name))) {
        report.base = {...report.base, status: "pending", detail: "Python の実行に必要な Ubuntu パッケージをすべて固定できません。"};
      }
      report.sources = {pythonIndex: PYPI, wheelMetadata: "PyPI Core Metadata"};
    }
    report.finishedAt = new Date().toISOString();
    report.notes = revisions(report);
    const dockerfile = makeDockerfile(report);
    render(report, dockerfile);
    latest = { report, dockerfile };
    const heading = $("result-title");
    if (heading.getBoundingClientRect().top >= window.innerHeight) heading.focus();
  } catch (error) {
    clearResult();
    setStatus("fetch", "調査処理に失敗");
    inputError.textContent = "調査を完了できませんでした — " + error.message;
    inputError.hidden = false;
  } finally {
    setBusy(false);
  }
});
