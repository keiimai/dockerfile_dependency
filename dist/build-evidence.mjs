import { makeDockerfile } from "./dockerfile.mjs?v=verification-1";
import records from "./build-records.mjs";

export async function recipeDigest(dockerfile) {
  // Only variable header comments are excluded. Keep every executable line and the Docker syntax directive.
  const normalized = dockerfile.split("\n").filter((line) => !line.startsWith("# ")).join("\n");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export async function buildEvidence(report, dockerfile) {
  const python = report.language === "python";
  const runtimeOnly = python && report.apt ? makeDockerfile({...report, requested:[],
    python:{ready:true, nodes:[], environment:{python_full_version:report.pythonVersion}}}) : "";
  const text = python ? runtimeOnly : dockerfile;
  if (!text) return null;
  const recipe = await recipeDigest(text);
  return records.findLast((row) => row.recipe === recipe &&
    row.scope === (python ? "python-runtime" : "r-dockerfile")) ?? null;
}
