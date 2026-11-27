import hashlib
import json
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import update_catalog as updater


def payload(value):
    data = json.dumps(value).encode()
    return data, "sha256:" + hashlib.sha256(data).hexdigest()


class CatalogTests(unittest.TestCase):
    def test_selects_latest_published_python_patches_without_prereleases(self):
        page = b'''<a href="/downloads/release/python-3139/">Python 3.13.9 - May 1</a>
                   <a href="/downloads/release/python-31310/">Python 3.13.10 - June 1</a>
                   <a href="/downloads/release/python-3140/">Python 3.14.0 - Oct. 7</a>
                   <a href="/downloads/release/python-3150rc1/">Python 3.15.0rc1 - Aug. 1</a>
                   <a href="/downloads/release/python-3200/">Python 3.99.0 - Invalid slug</a>'''
        with patch.object(updater, "fetch", return_value=page) as fetch:
            self.assertEqual(updater.python_series(), {"3.13": "3.13.10", "3.14": "3.14.0"})
            fetch.assert_called_once_with(updater.PYTHON_DOWNLOADS)

    def test_finds_stable_releases_across_r_major_versions(self):
        with patch.object(updater, "fetch", side_effect=[
            b'<a href="R-4/">R-4</a><a href="R-5/">R-5</a>',
            b'<a href="R-4.6.9.tar.gz"><a href="R-4.6.10.tar.gz">',
            b'<a href="R-5.0.0-rc1.tar.gz"><a href="R-5.0.0.tar.gz">',
        ]):
            self.assertEqual(updater.cran_versions((4, 6, 9)), ["4.6.9", "4.6.10", "5.0.0"])

    def test_publishes_only_new_versions_with_a_supported_image(self):
        catalog = {"noble": {"r": {"4.6.1": {"arm64": "old"}}}, "resolute": {"r": {}}}
        with (
            patch.object(updater, "cran_versions", return_value=["4.6.1", "4.6.2", "4.6.3", "4.6.4"]),
            patch.object(updater, "rocker_token", return_value="token"),
            patch.object(updater, "rocker_image", side_effect=[
                ("resolute", {"arm64": "new"}), None, ("jammy", {"arm64": "ignored"}),
            ]) as image,
        ):
            updater.refresh_r(catalog)
        self.assertEqual([call.args[0] for call in image.call_args_list], ["4.6.2", "4.6.3", "4.6.4"])
        self.assertEqual(catalog, {
            "noble": {"r": {"4.6.1": {"arm64": "old"}}},
            "resolute": {"r": {"4.6.2": {"arm64": "new"}}},
        })

    def test_verifies_manifest_config_hash_architecture_and_base(self):
        version = "4.6.10"
        config, config_hash = payload({
            "os": "linux", "architecture": "arm64",
            "config": {"Env": [f"R_VERSION={version}"], "Labels": {
                "org.opencontainers.image.base.name": "docker.io/library/ubuntu:resolute",
            }},
        })
        manifest, digest = payload({"config": {"digest": config_hash}})
        index, _ = payload({"manifests": [{"digest": digest, "platform": {"os": "linux", "architecture": "arm64"}}]})
        with patch.object(updater, "fetch", side_effect=[index, manifest, config]):
            self.assertEqual(updater.rocker_image(version, "token"), ("resolute", {"arm64": digest}))
        with patch.object(updater, "fetch", side_effect=[index, manifest, b"corrupt config"]):
            with self.assertRaisesRegex(ValueError, "Digest mismatch"):
                updater.rocker_image(version, "token")
        amd, _ = payload({"manifests": [{"digest": digest, "platform": {"os": "linux", "architecture": "amd64"}}]})
        with patch.object(updater, "fetch", return_value=amd):
            self.assertIsNone(updater.rocker_image(version, "token"))

    def test_retries_unpublished_versions_and_propagates_source_outages(self):
        for status in (404, 503):
            with patch.object(updater, "fetch", side_effect=HTTPError(updater.ROCKER, status, "", {}, None)):
                if status == 404:
                    self.assertIsNone(updater.rocker_image("4.6.10", "token"))
                else:
                    with self.assertRaises(HTTPError):
                        updater.rocker_image("4.6.10", "token")

    def test_probes_python_updates_without_refreshing_for_unrelated_packages(self):
        for version, needs_refresh in [("3.14.4-1", False), ("3.14.5-1", True)]:
            old = {"suite": "resolute-updates", "path": updater.MAIN_PACKAGES, "sha256": "old"}
            new = {**old, "sha256": "new"}
            saved = {"sources": [old], "packages": [
                ["python3.14", "3.14.4-1", "resolute-updates", "main"],
                ["libgdal-dev", "1.0", "resolute-updates", "main"],
            ]}
            with (
                patch.object(updater, "verified_index"),
                patch.object(updater, "packages", return_value=iter([
                    ["python3.14", version, "resolute-updates", "main"],
                    ["libgdal-dev", "2.0", "resolute-updates", "main"],
                ])),
            ):
                self.assertIs(updater.runtime_changed(saved, [new], Path(".")), needs_refresh)
