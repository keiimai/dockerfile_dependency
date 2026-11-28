export default [
  {
    "scope": "r-dockerfile",
    "status": "passed",
    "recipe": "392d9c44a2eebedecc410bc5b61bcd890c86b89a5d257bbd603ea1a4300c1874",
    "release": "noble",
    "platform": "linux/arm64",
    "image": "rocker/rstudio:4.6.1@sha256:1ad536779cc2354f075fd28e9a67dea895b4605def6299a3a81d555a2e4ca925",
    "version": "4.6.1",
    "date": "2026-11-28",
    "packages": [
      "rbugs",
      "jsonlite"
    ],
    "logSha256": "fa0837fe05403435280dd589b794a52c86be959cffabcd4f110652896ee005da",
    "detail": "rbugs 0.5-9.1 と jsonlite 2.0.0 のインストールとイメージ出力が完了。"
  },
  {
    "scope": "r-dockerfile",
    "status": "failed",
    "recipe": "75826d7eaec8b0a1d7821ba95d62fa818c97528cf02eba90f4b0a5374ccc3a42",
    "release": "noble",
    "platform": "linux/arm64",
    "image": "rocker/rstudio:4.6.1@sha256:1ad536779cc2354f075fd28e9a67dea895b4605def6299a3a81d555a2e4ca925",
    "version": "4.6.1",
    "date": "2026-11-28",
    "packages": [
      "maptools",
      "jsonlite"
    ],
    "logSha256": "9181c879b5808a665c6f09c8904d2b602db23b5fda431c6734782bce879ed610",
    "detail": "maptools 1.1-8 のコンパイルで -Werror=format-security。"
  },
  {
    "scope": "python-runtime",
    "status": "passed",
    "series": "3.15",
    "version": "3.15.2",
    "release": "noble",
    "recipe": "f49d9eff11af0277cad674ac83d596e04be1468205a24fe4f4ee95f005242ae0",
    "image": "ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289",
    "platform": "linux/arm64",
    "sha256": "f74e1db0eabd651cd01e4e2a00201bd41866abe74869ab716f9bf33cbbaa0943",
    "snapshot": "20261127T210000Z",
    "checkedAt": "2026-11-28T01:45:54.770Z",
    "source": "https://github.com/keiimai/dockerfile_dependency/actions/runs/46094542801",
    "checks": [
      "arm64",
      "python_version",
      "venv",
      "ssl",
      "sqlite3",
      "bz2",
      "lzma",
      "zlib",
      "ctypes",
      "readline"
    ]
  },
  {
    "scope": "python-runtime",
    "status": "passed",
    "series": "3.15",
    "version": "3.15.2",
    "release": "resolute",
    "recipe": "c550810517c83c735f4fa10c0b4e1f0fc95ca0765d55f15cd476fbc30ef0e1e1",
    "image": "ubuntu:26.04@sha256:7e7957462d7b6db141de67623f46135d82a6bc131bc2ff369aedfccfa91c0a1b",
    "platform": "linux/arm64",
    "sha256": "f74e1db0eabd651cd01e4e2a00201bd41866abe74869ab716f9bf33cbbaa0943",
    "snapshot": "20261127T210000Z",
    "checkedAt": "2026-11-28T01:48:21.179Z",
    "source": "https://github.com/keiimai/dockerfile_dependency/actions/runs/46094542801",
    "checks": [
      "arm64",
      "python_version",
      "venv",
      "ssl",
      "sqlite3",
      "bz2",
      "lzma",
      "zlib",
      "ctypes",
      "readline"
    ]
  }
];
