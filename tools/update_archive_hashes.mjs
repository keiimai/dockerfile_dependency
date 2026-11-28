import {readFileSync,writeFileSync} from "node:fs";
import catalog from "../dist/archive-hashes.mjs";
import {archiveIdentity, CRAN, compareR, fetchArchived, pinRArchive} from "../dist/r-resolver.mjs";

const seed = [["rbugs","0.5-9.1"], ["maptools","1.1-8"]];
const read = async (url) => {
  const res = await fetch(url, {signal:AbortSignal.timeout(45000)});
  if (!res.ok) throw new Error(url + " HTTP " + res.status);
  return res;
};
async function register(name, version) {
  const url = CRAN + "/Archive/" + name + "/" + name + "_" + version + ".tar.gz";
  if (catalog[url]) return;
  const node = await fetchArchived(name, version);
  if (node.status !== "ok") return;
  const response = await read(url);
  if (Number(response.headers.get("content-length")) > 128 * 1024 ** 2) { await response.body.cancel(); return; }
  const file = await response.blob();
  const {sha256,hashEvidence} = await pinRArchive(node, file, "cran-archive-catalog");
  catalog[url] = {url, sha256, hashEvidence, identity:archiveIdentity(node)};
}
for (const [name,version] of seed) await register(name,version);
if (process.argv.includes("--refresh")) {
  // Rotate through the official directory in bounded batches; the most recent old version comes first.
  const html = await (await read(CRAN + "/Archive/")).text();
  const names = [...new Set(Array.from(html.matchAll(/href="([A-Za-z][A-Za-z0-9.]*)\/"/g), m => m[1]))].sort();
  if (!names.length) throw new Error("Empty CRAN Archive directory");
  const cursorPath = "tools/archive-cursor.txt";
  const cursor = readFileSync(cursorPath,"utf8").trim();
  const start = names.findIndex((name) => name > cursor);
  const batch = names.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 24);
  for (const name of batch) {
    try {
      const listing = await (await read(CRAN + "/Archive/" + name + "/")).text();
      const versions = Array.from(listing.matchAll(/href="([A-Za-z0-9.]+)_([0-9]+(?:[.-][0-9]+)*)\.tar\.gz"/g))
        .filter((match) => match[1] === name).map((match) => match[2]).sort((a,b) => compareR(b,a));
      for (const version of versions.slice(0,2)) await register(name,version);
    } catch (error) { console.warn(name, error.message); }
  }
  writeFileSync(cursorPath,batch.at(-1) + "\n");
}
writeFileSync("dist/archive-hashes.mjs","export default " + JSON.stringify(catalog,null,2) + ";\n");
