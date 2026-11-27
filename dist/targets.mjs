import catalog from "./runtime-catalog.mjs";

export const TARGETS = {
  noble: {
    label: "Ubuntu 24.04", version: "24.04", python: catalog.noble.python.split(".").slice(0, 2).join("."), glibc: 39,
    image: "ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289",
  },
  resolute: {
    label: "Ubuntu 26.04", version: "26.04", python: catalog.resolute.python.split(".").slice(0, 2).join("."), glibc: 43,
    image: "ubuntu:26.04@sha256:7e7957462d7b6db141de67623f46135d82a6bc131bc2ff369aedfccfa91c0a1b",
  },
};
