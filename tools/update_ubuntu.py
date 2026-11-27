#!/usr/bin/env python3
"""Build the browser's Ubuntu arm64 catalog from an official snapshot."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ("main", "restricted", "universe", "multiverse")
FIELDS = ("Package", "Version", "Architecture", "Depends", "Pre-Depends",
          "Provides", "Multi-Arch", "Conflicts", "Breaks", "Source")
LIBRARY = re.compile(rb"^(?:usr/)?lib/(?:aarch64-linux-gnu/(?:[^/\s]+/)*)?(lib[^/\s]+\.so(?:\.[^/\s]+)?)$")
PACKAGE = re.compile(rb"[a-z0-9][a-z0-9+.-]*")


def download(url, target):
    """Download and calculate SHA-256 in a single pass."""
    sha256 = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=90) as source, target.open("wb") as out:
        while chunk := source.read(1024 * 1024):
            sha256.update(chunk)
            out.write(chunk)
    return sha256.hexdigest()


def release_indexes(base, suite, scratch):
    url = f"{base}/dists/{suite}/Release"
    release = scratch / f"{suite}.Release"
    release_hash = download(url, release)
    header, sha = release.read_text().split("\nSHA256:\n", 1)
    date = next(line[6:].strip() for line in header.splitlines() if line.startswith("Date: "))
    checksums = {}
    for line in sha.splitlines():
        if not line.startswith(" "):
            break
        digest, _, path = line.split()
        checksums[path] = digest

    sources = [{"kind": "Release", "suite": suite, "url": url, "date": date, "sha256": release_hash}]
    paths = [("Packages", f"{component}/binary-arm64/Packages.xz") for component in COMPONENTS]
    paths.append(("Contents", "Contents-arm64.gz"))
    for kind, path in paths:
        sources.append({"kind": kind, "suite": suite, "path": path,
                        "url": f"{base}/dists/{suite}/{path}", "sha256": checksums[path]})
    return sources


def paragraphs(stream):
    record = {}
    for line in stream:
        if not line.strip():
            if record:
                yield record
                record = {}
        elif not line.startswith((" ", "\t")):
            key, _, value = line.partition(": ")
            if key in FIELDS:
                record[key] = value.strip()
    if record:
        yield record


def packages(path, source):
    with lzma.open(path, "rt", encoding="utf-8") as stream:
        for record in paragraphs(stream):
            if record["Architecture"] in ("arm64", "all"):
                yield [*(record.get(field, "") for field in FIELDS),
                       source["suite"], source["path"].split("/")[0]]


def contents(path):
    with gzip.open(path, "rb") as stream:
        for line in stream:
            fields = line.split()
            if len(fields) != 2:
                continue
            path_match = LIBRARY.fullmatch(fields[0])
            if path_match:
                names = [item.rsplit(b"/", 1)[-1] for item in fields[1].split(b",")]
                yield path_match[1].decode("ascii", errors="replace"), [
                    name.decode("ascii") for name in names if PACKAGE.fullmatch(name)]


def verified_index(source, scratch):
    target = scratch / (source["suite"] + "-" + source["path"].replace("/", "-"))
    if not target.exists():
        if download(source["url"], target) != source["sha256"]:
            raise ValueError(f"SHA-256 mismatch: {source['url']}")
        print(f"Verified {source['url']}", flush=True)
    return target


def load(source, scratch):
    target = verified_index(source, scratch)
    if source["kind"] == "Packages":
        return list(packages(target, source)), {}
    libraries = defaultdict(set)
    for name, providers in contents(target):
        libraries[name].update(providers)
    return [], libraries


def snapshot_sources(snapshot, scratch, release):
    base = f"https://snapshot.ubuntu.com/ubuntu/{snapshot}"
    suites = (release, f"{release}-updates", f"{release}-security")
    with ThreadPoolExecutor(max_workers=3) as pool:
        return [source for group in pool.map(lambda suite: release_indexes(base, suite, scratch), suites)
                for source in group]


def update(snapshot, scratch, release="noble", *, sources=None, destination=None):
    suites = (release, f"{release}-updates", f"{release}-security")
    base = f"https://snapshot.ubuntu.com/ubuntu/{snapshot}"
    if sources is None:
        sources = snapshot_sources(snapshot, scratch, release)
    with ThreadPoolExecutor(max_workers=6) as pool:
        tasks = [source for source in sources if source["kind"] != "Release"]
        rows = []
        libraries = defaultdict(set)
        for records, providers in pool.map(lambda source: load(source, scratch), tasks):
            rows.extend(records)
            for name, names in providers.items():
                libraries[name].update(names)

    data = {
        "schema": 1,
        "snapshot": snapshot,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base": base,
        "architecture": "arm64",
        "suites": suites,
        "components": COMPONENTS,
        "sources": sources,
        "fields": (*FIELDS, "Suite", "Component"),
        "packages": sorted(rows),
        "libraries": {name: sorted(names) for name, names in sorted(libraries.items())},
    }
    staging = scratch / f"ubuntu-{release}-arm64.json.gz"
    with gzip.open(staging, "wt", encoding="utf-8", compresslevel=8) as out:
        json.dump(data, out, ensure_ascii=False, separators=(",", ":"))
    destination = destination or ROOT / f"dist/data/ubuntu-{release}-arm64.json.gz"
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging.replace(destination)
    print(f"{destination}: {len(rows):,} package records, {len(libraries):,} library names")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="Ubuntu snapshot UTC time, e.g. 20261127T070249Z")
    parser.add_argument("--release", choices=("noble", "resolute"), default="noble")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", args.snapshot):
        parser.error("use YYYYMMDDTHHMMSSZ")
    datetime.strptime(args.snapshot, "%Y%m%dT%H%M%SZ")
    from update_catalog import main as refresh_catalog

    refresh_catalog(["--snapshot", args.snapshot, "--force-index", "--release", args.release])


if __name__ == "__main__":
    main()
