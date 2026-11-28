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
  }
];
