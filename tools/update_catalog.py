#!/usr/bin/env python3
"""Refresh verified R images and Ubuntu's Python runtime for the static site."""

import argparse
from base64 import b64decode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from update_ubuntu import ROOT, packages, snapshot_sources, update, verified_index

CRAN = "https://cloud.r-project.org/src/base/"
PYTHON_DOWNLOADS = "https://www.python.org/downloads/source/"
UBUNTU_RELEASES = ("noble", "resolute")
ROCKER = "https://registry-1.docker.io/v2/rocker/rstudio"
MEDIA = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
PYTHON_PACKAGE = re.compile(r"(?:lib)?python3(?:\.\d+)?(?:-[a-z0-9.-]+)?")
MAIN_PACKAGES = "main/binary-arm64/Packages.xz"
CATALOG = ROOT / "dist/runtime-catalog.mjs"
PREFIX = "export default "
SUFFIX = ";\n"
REFRESH_AFTER = timedelta(days=28)


def fetch(url, *, token=None, accept=None):
    request = Request(url, headers={"User-Agent": "dockerfile-dependency-catalog/1"})
    if token:
        request.add_unredirected_header("Authorization", f"Bearer {token}")
    if accept:
        request.add_header("Accept", accept)
    with urlopen(request, timeout=60) as response:
        return response.read()


def read_catalog(path):
    data = path.read_text()
    if not data.startswith(PREFIX) or not data.endswith(SUFFIX):
        raise ValueError(f"Unsupported catalog format: {path}")
    return json.loads(data.removeprefix(PREFIX).removesuffix(SUFFIX))


def version_key(version):
    return tuple(map(int, version.split(".")))


def python_releases():
    entries = re.findall(r'href="/downloads/release/python-(\d+)/"[^>]*>\s*Python\s+(3\.\d+\.\d+)\s+-',
                         fetch(PYTHON_DOWNLOADS).decode())
    versions = {version for slug, version in entries if slug == version.replace(".", "") and version_key(version) >= (3, 10)}
    if not versions:
        raise ValueError("Python.org did not list any stable CPython 3 releases")
    return sorted(versions, key=version_key)


def python_series(versions=None):
    series = {}
    for version in python_releases() if versions is None else versions:
        minor = version.rsplit(".", 1)[0]
        if minor not in series or version_key(version) > version_key(series[minor]):
            series[minor] = version
    return series


def python_release_checksum(version, tarball):
    release_url = f"https://www.python.org/downloads/release/python-{version.replace('.', '')}/"
    page = fetch(release_url).decode()
    rows = re.findall(r"<tr\b[^>]*>.*?</tr>", page, re.S)
    row = next((row for row in rows if f'href="{tarball}"' in row), "")
    code = re.search(r'<code class="checksum">(.*?)</code>', row, re.S)
    return re.sub(r"<[^>]+>|\s+", "", code[1]) if code else ""


def python_source_record(version, *, latest=False):
    page = f"https://www.python.org/downloads/release/python-{version.replace('.', '')}/"

    def record(digest, method, source):
        return digest, {"method": method, "source": source, "checkedAt": datetime.now(timezone.utc).isoformat()}

    tarball = f"https://www.python.org/ftp/python/{version}/Python-{version}.tgz"
    checksum = python_release_checksum(version, tarball) if latest else None
    if re.fullmatch(r"[a-f0-9]{64}", checksum or ""):
        return record(checksum, "python-release-sha256", page)

    try:
        payload = json.loads(fetch(tarball + ".sigstore"))
    except HTTPError as error:
        if error.code != 404:
            raise
    else:
        declared = payload.get("messageSignature", {}).get("messageDigest", {})
        if declared.get("algorithm") == "SHA2_256":
            digest = b64decode(declared["digest"], validate=True)
            if len(digest) == 32:
                return record(digest.hex(), "sigstore-declared-digest", tarball + ".sigstore")

    # Some archived release pages only publish MD5. Verify the HTTPS download
    # against that value, then lock the downloaded bytes with SHA-256.
    checksum = checksum if checksum is not None else python_release_checksum(version, tarball)
    if re.fullmatch(r"[a-f0-9]{64}", checksum):
        return record(checksum, "python-release-sha256", page)
    if re.fullmatch(r"[a-f0-9]{32}", checksum):
        contents = fetch(tarball)
        if hashlib.md5(contents, usedforsecurity=False).hexdigest() != checksum:
            raise ValueError(f"Python.org checksum mismatch for CPython {version}")
        return record(hashlib.sha256(contents).hexdigest(), "artifact-sha256-after-md5", page)
    return None, None


def refresh_python_sources(versions, series, catalog):
    sources = catalog.setdefault("pythonSources", {})
    evidence = catalog.setdefault("pythonHashEvidence", {})
    latest = set(series.values())
    missing = [v for v in versions if not sources.get(v) or not evidence.get(v)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        for version, (digest, proof) in zip(missing, pool.map(lambda v: python_source_record(v, latest=v in latest), missing)):
            if sources.get(version) and digest != sources[version]:
                raise ValueError(f"Previously pinned CPython {version} digest could not be reproduced")
            if digest:
                sources[version], evidence[version] = digest, proof
    if unavailable := sorted(v for v in latest if not sources.get(v)):
        raise ValueError("No official CPython SHA-256 for " + ", ".join(unavailable))


def cran_versions(minimum):
    index = fetch(CRAN).decode()
    majors = {int(major) for major in re.findall(r'href="R-(\d+)/"', index) if int(major) >= minimum[0]}
    if not majors:
        raise ValueError("CRAN source release index did not list an expected major version")
    versions = set()
    for major in sorted(majors):
        text = fetch(f"{CRAN}R-{major}/").decode()
        found = re.findall(rf'href="R-({major}\.\d+\.\d+)\.tar\.gz"', text)
        versions.update(version for version in found if version_key(version) >= minimum)
    if not versions:
        raise ValueError("CRAN did not list any expected stable releases")
    return sorted(versions, key=version_key)


def rocker_token():
    endpoint = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:rocker/rstudio:pull"
    return json.loads(fetch(endpoint))["token"]


def rocker_image(version, token):
    def registry(path, digest=None):
        data = fetch(f"{ROCKER}/{path}", token=token, accept=MEDIA)
        own_digest = "sha256:" + hashlib.sha256(data).hexdigest()
        if digest and digest != own_digest:
            raise ValueError(f"Digest mismatch for {path}")
        return json.loads(data), own_digest

    try:
        manifest, digest = registry(f"manifests/{version}")
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if "manifests" in manifest:
        arm64 = [image["digest"] for image in manifest["manifests"]
                 if image.get("platform", {}).get("os") == "linux"
                 and image.get("platform", {}).get("architecture") == "arm64"
                 and image["platform"].get("variant", "v8") == "v8"]
        if len(arm64) != 1:
            return None
        digest = arm64[0]
        if not DIGEST.fullmatch(digest):
            raise ValueError(f"Invalid manifest digest for R {version}")
        manifest, _ = registry(f"manifests/{digest}", digest)
    if not DIGEST.fullmatch(config_digest := manifest["config"]["digest"]):
        raise ValueError(f"Invalid image config digest for R {version}")
    config, _ = registry(f"blobs/{config_digest}", config_digest)
    if (config.get("os"), config.get("architecture")) != ("linux", "arm64"):
        return None
    runtime = config.get("config", {})
    if f"R_VERSION={version}" not in runtime.get("Env", []):
        return None
    base = (runtime.get("Labels") or {}).get("org.opencontainers.image.base.name", "")
    match = re.fullmatch(r"(?:(?:docker\.io/)?library/)?ubuntu:([a-z][a-z0-9-]+)(?:@sha256:[a-f0-9]{64})?", base)
    if not match:
        return None
    return match[1], {"arm64": digest}


def refresh_r(catalog):
    known = {version for release in UBUNTU_RELEASES for version in catalog[release]["r"]}
    candidates = [version for version in cran_versions((4, 5, 1)) if version not in known]
    if not candidates:
        return
    token = rocker_token()
    for version in candidates:
        image = rocker_image(version, token)
        if image and image[0] in UBUNTU_RELEASES:
            release, fixed = image
            catalog[release]["r"][version] = fixed
            print(f"Verified R {version} / {release} / arm64 {fixed['arm64']}", flush=True)
        else:
            print(f"R {version}: no matching Rocker linux/arm64 image on a supported Ubuntu release", flush=True)


def runtime_rows(rows, suite):
    return {tuple(row) for row in rows
            if row[-2:] == [suite, "main"] and PYTHON_PACKAGE.fullmatch(row[0])}


def runtime_changed(saved, sources, scratch):
    old_hashes = {(source["suite"], source.get("path")): source["sha256"] for source in saved["sources"]}
    for source in sources:
        key = (source["suite"], source.get("path"))
        if key[1] != MAIN_PACKAGES or source["sha256"] == old_hashes.get(key):
            continue
        new = packages(verified_index(source, scratch), source)
        if runtime_rows(saved["packages"], key[0]) != runtime_rows(new, key[0]):
            return True
    return False


def timestamp(value):
    return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def refresh_ubuntu(release, target, snapshot, staging, force):
    path = ROOT / f"dist/data/ubuntu-{release}-arm64.json.gz"
    with gzip.open(path, "rt") as stream:
        saved = json.load(stream)
    if saved["snapshot"] != target["snapshot"] or saved["suites"][0] != release:
        raise ValueError(f"Catalog and staged index do not match for {release}")
    age = timestamp(snapshot) - timestamp(saved["snapshot"])
    if age < timedelta(0) and force:
        raise ValueError(f"Refusing to replace {release} with an older snapshot")
    if age <= timedelta(0) and not force:
        return None
    scratch = staging / release
    scratch.mkdir()
    sources = snapshot_sources(snapshot, scratch, release)
    signed = all(s.get("signature") for s in saved["sources"] if s["kind"] == "Release")
    if not (force or not signed or age >= REFRESH_AFTER or runtime_changed(saved, sources, scratch)):
        return None

    candidate = staging / path.name
    update(snapshot, scratch, release, sources=sources, destination=candidate)
    python = subprocess.check_output(
        ["node", str(ROOT / "tools/check_python_runtime.mjs"), release, str(candidate)], text=True,
    ).strip()
    print(f"Verified Ubuntu {release} / CPython {python} / snapshot {snapshot}", flush=True)
    target.update(snapshot=snapshot, python=python)
    return candidate, path


def backfill_ubuntu_signatures():
    work = ROOT / "_tmp"
    work.mkdir(exist_ok=True)
    for release in UBUNTU_RELEASES:
        path = ROOT / f"dist/data/ubuntu-{release}-arm64.json.gz"
        with gzip.open(path, "rt") as stream:
            saved = json.load(stream)
        if all(s.get("signature") for s in saved["sources"] if s["kind"] == "Release"):
            continue
        with tempfile.TemporaryDirectory(dir=work) as temp:
            scratch = Path(temp)
            sources = snapshot_sources(saved["snapshot"], scratch, release)
            def sums(rows):
                return {s["url"]: s["sha256"] for s in rows}
            if sums(sources) != sums(saved["sources"]):
                raise ValueError(f"Signed Release disagrees with the published {release} snapshot")
            saved["sources"] = sources
            candidate = scratch / path.name
            with gzip.open(candidate, "wt", encoding="utf-8", compresslevel=8) as stream:
                json.dump(saved, stream, ensure_ascii=False, separators=(",", ":"))
            candidate.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hash-provenance", action="store_true", help="Backfill evidence for cataloged CPython archives")
    parser.add_argument("--snapshot", help="Official Ubuntu snapshot UTC time (YYYYMMDDTHHMMSSZ)")
    parser.add_argument("--force-index", action="store_true", help="Refresh both complete Ubuntu indexes")
    parser.add_argument("--release", choices=UBUNTU_RELEASES, help="Refresh only this Ubuntu release")
    args = parser.parse_args(argv)
    snapshot = args.snapshot or (datetime.now(timezone.utc) - timedelta(hours=12)).strftime("%Y%m%dT%H%M%SZ")
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", snapshot):
        parser.error("use YYYYMMDDTHHMMSSZ")
    timestamp(snapshot)

    catalog = read_catalog(CATALOG)
    if args.hash_provenance:
        catalog["pythonSeries"] = {k:v for k,v in catalog["pythonSeries"].items() if version_key(k) >= (3, 10)}
        refresh_python_sources(list(catalog["pythonSources"]), catalog["pythonSeries"], catalog)
        backfill_ubuntu_signatures()
        CATALOG.write_text(PREFIX + json.dumps(catalog, indent=2, sort_keys=True) + SUFFIX)
        return
    before = json.dumps(catalog, sort_keys=True)
    refresh_r(catalog)
    releases = python_releases()
    catalog["pythonSeries"] = python_series(releases)
    refresh_python_sources(releases, catalog["pythonSeries"], catalog)
    work = ROOT / "_tmp"
    work.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="runtime-catalog-", dir=work) as temp:
        staging = Path(temp)
        staged = [candidate for release in UBUNTU_RELEASES
                  if args.release in (None, release)
                  if (candidate := refresh_ubuntu(release, catalog[release], snapshot, staging, args.force_index))]
        if json.dumps(catalog, sort_keys=True) == before and not staged:
            print("No verified runtime or index update")
            return
        module = staging / CATALOG.name
        module.write_text(PREFIX + json.dumps(catalog, indent=2, sort_keys=True) + SUFFIX)
        for candidate, destination in staged:
            candidate.replace(destination)
        module.replace(CATALOG)


if __name__ == "__main__":
    main()
