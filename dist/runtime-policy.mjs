export const minimumVersions = {r: "4.5.1", python: "3.10"};

export function supportedRuntime(language, version) {
  const pattern = language === "r" ? /^\d+\.\d+\.\d+$/ : /^3\.\d+(?:\.\d+)?$/;
  if (!pattern.test(version)) return false;
  const parts = version.split(".").map(Number);
  const floor = minimumVersions[language].split(".").map(Number);
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}
