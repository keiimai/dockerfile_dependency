# R・Python パッケージの依存調査

「言語」で R または Python を選び、版とパッケージ名を入力すると、ブラウザが公開メタデータを取得して依存を調査します。両言語の対象は Ubuntu 24.04（Noble）、`linux/arm64` です。サイトの入口は [dist/index.html](dist/index.html) です。

## ローカルで確認する

このディレクトリで静的ファイルを配信します。Python はこのローカル確認と Ubuntu 索引の更新に使います。公開後の利用者はブラウザだけで使えます。

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

1. ブラウザで [http://127.0.0.1:8765/](http://127.0.0.1:8765/) を開きます。
2. 「言語」で R または Python を選びます。「ggplot2 + sf を入力」または「requests + numpy を入力」で例を試せます。任意のパッケージ名は改行、カンマ、空白で区切れます。言語ごとに入力を保持し、言語を切り替えた後は再調査します。
3. 「調査する」を押し、選んだ言語の依存一覧、Ubuntu 候補と根拠、確認事項を見ます。「APT の依存一覧」を開くと、版ごとの `Depends`、`Pre-Depends`、代替や仮想パッケージの候補が見られます。
4. 「Dockerfile」と「調査記録（JSON）」を保存します。Dockerfile は単体で、補助ファイルは不要です。言語の依存や対象のベースが未確定の場合、APT の固定候補が競合または判定保留の場合は、調査記録を保存できます。入力を編集すると前回の結果と保存ボタンが消えます。

存在しない名前の例は `NoSuchAuditDemoPackage20261127` です。API が 404 を返すと「見つからない」と表示します。ブラウザの開発者ツールで `https://cran.r-universe.dev/api/packages/*` だけの通信を遮断して実行すると、「取得失敗」と表示します。R `4.0.0` と現在の `ggplot2` を指定すると、公開候補の R 版条件との競合を確認できます。

APT と Python の回帰テストは `node --test tests/*.test.mjs` で実行できます。

## GitHub Pages に配置する

公開時は専用リポジトリの公開元ブランチのルートに、`dist/` の**中身**を配置します。`index.html`、JavaScript とスタイル、`data/`、隠しファイルの `.nojekyll` を含めます。

GitHub の **Settings → Pages** で **Deploy from a branch** を選び、対象ブランチと **/ (root)** を指定します。`/docs` を公開元にする場合は、その配下に同じ構成を置けます。サイトにビルドや利用者操作で起動するワークフローを設定する必要はありません。 [GitHub Pages の公式手順](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Ubuntu 索引を更新する

このディレクトリから、対象のスナップショット時刻を UTC の `YYYYMMDDTHHMMSSZ` 形式で指定します。出荷時は `20261127T070249Z` です。

```sh
python3 tools/update_ubuntu.py 20261127T070249Z
```

スクリプトは Ubuntu Snapshot Service の `noble`、`noble-updates`、`noble-security` を対象に、4 コンポーネントの `binary-arm64/Packages.xz` と各スイートの `Contents-arm64.gz` を取得します。各 `Release` の SHA-256 に照合し、arm64 と all のパッケージ、版、依存、提供関係、共有ライブラリのファイル名を抽出します。一時ファイルは `_tmp/` を使い、成功時に `dist/data/ubuntu-noble-arm64.json.gz` を置き換えます。参照 URL、索引のハッシュ、スナップショット日時、取得日時は、データと調査記録に入ります。 [Ubuntu Snapshot Service](https://snapshot.ubuntu.com/)

## Python の調査と生成

- **対象環境。** 参照プロジェクトと同じダイジェストの Ubuntu 24.04 arm64 を使います。`3.12` と入力すると Ubuntu 索引のパッチ版を使います。同梱索引では `3.12.3` です。パッチ版を明示した場合は一致を確認します。`python3`、`python3.12`、`python3-venv`、`ca-certificates` の版を同じ索引で固定します。
- **PyPI の調査。** 調査のたびに [PyPI Index API](https://docs.pypi.org/api/index-api/) と配布物ごとの Core Metadata を取得し、`Requires-Python`、`Requires-Dist`、対象環境のマーカー、wheel タグを照合します。必要なら旧版を探索します。非撤回の安定版 wheel を対象にします。対応する wheel や照合可能なメタデータが無い場合、判定できないマーカーがある場合、探索が上限に達した場合には生成を保留します。版比較ライブラリとそのライセンスは `dist/vendor/pep440/` に同梱しています。
- **Ubuntu の依存。** wheel が `Requires-External` を公開している場合は候補として表示します。Ubuntu パッケージは任意欄から直接指定できます。wheel の共有ライブラリの実測は調査範囲外です。
- **生成物。** Dockerfile は仮想環境を作り、選択した wheel の URL と SHA-256 を使って pip で導入し、`pip check` で依存を検査します。選択した wheel を調査記録でも確認できます。

## R と共通の調査範囲

- **ベースイメージ。** R `4.5.3` は参照プロジェクト `docker_container_audit/` と同じ `rocker/rstudio` の固定ダイジェストを使います。 `4.5.2`、`4.6.0`、`4.6.1` は Ubuntu Noble と arm64 が確認できた Rocker マニフェストを使います。入力された他の版も R の依存を調査します。Ubuntu 24.04 のベースが確認できない版では Dockerfile を生成しません。`4.6.2` の確認済み Rocker イメージは Ubuntu 26.04 です。対応版の情報は `dist/dockerfile.mjs` にあります。 [Rocker のバージョン付きイメージ](https://rocker-project.org/images/versioned/rstudio)
- **R パッケージ。** 調査のたびに R-universe の CRAN 公開版 API を取得し、`Depends`、`Imports`、`LinkingTo` を再帰的にたどります。CRAN の公開から API への反映には時間差があります。旧版の探索や Bioconductor など別の配布元は対象外です。取得できた公開候補だけで条件を満たせない場合は判定保留になり、指定の R 版との不適合や公開候補同士の両立しない条件は競合になります。同梱標準パッケージは R と同じ版として扱い、推奨パッケージは公開版を調べます。 [R-universe API](https://docs.r-universe.dev/browse/api.html)
- **Ubuntu パッケージ。** `SystemRequirements` の対応表、`Config/pak/sysreqs`、R-universe が報告した共有ライブラリ名、任意入力を根拠に、公式索引で候補を確認します。共有ライブラリの報告元が別の環境の場合、対象環境で必要なライブラリの実測値とは異なることがあります。対応表で明確に解釈できる直接要件と任意入力のうち、索引の版条件に合う実パッケージを、確認できた範囲で Dockerfile に固定します。自由記述、複数候補、ライブラリ名だけを根拠とする項目は調査記録で確認できます。直接固定する候補について、同一パッケージの版、代替・仮想パッケージ、Conflicts・Breaks を含む必須依存の組み合わせを索引上で確認します。組み合わせが競合する場合や、メタデータ不足・探索上限で判定できない場合は、根拠を表示して Dockerfile の生成を止めます。生成した参考例では、APT が同じスナップショットから間接依存を選びます。ベースの導入状況と実際の APT による導入は未確認です。
- **Dockerfile。** CRAN の版付きソース URL と、その版が移動した場合の Archive URL を記録します。生成された Dockerfile は対象の OS、アーキテクチャ、R の版を検査し、導入前にソース配布物の `DESCRIPTION` の名前、版、必須依存を照合します。配布物のハッシュは一般のブラウザ調査では固定していません。実際の Docker ビルド、R パッケージの読み込み、共有ライブラリの動作確認はデモの範囲外です。
