// Read a single DESCRIPTION record without extracting files from the archive.
export function readDescription(text) {
  const fields = Object.create(null);
  let field;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (field) break;
      continue;
    }
    if (/^[ \t]/.test(line) && field) {
      fields[field] += " " + line.trim();
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9/._@-]*):[ \t]*(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw new Error("DESCRIPTION の形式を確認できません。");
    [, field] = match;
    fields[field] = match[2].trim();
  }
  return fields;
}

const maxTarBytes = 128 * 1024 * 1024;
const maxDescriptionBytes = 256 * 1024;

export async function readArchiveDescription(file, packageName) {
  if (file.size > maxTarBytes) throw new Error("配布物が 128 MB を超えています。");
  const reader = file.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  let chunk = new Uint8Array(0);
  let offset = 0;
  let processed = 0;

  async function read(length, retain = true) {
    processed += length;
    if (processed > maxTarBytes) throw new Error("展開後 128 MB 以内で DESCRIPTION を確認できません。");
    const result = retain ? new Uint8Array(length) : null;
    for (let copied = 0; copied < length;) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) throw new Error("配布物に DESCRIPTION がありません。");
        chunk = next.value;
        offset = 0;
      }
      const count = Math.min(length - copied, chunk.length - offset);
      if (retain) result.set(chunk.subarray(offset, offset + count), copied);
      offset += count;
      copied += count;
    }
    return result;
  }

  const decoder = new TextDecoder();
  const string = (bytes) => decoder.decode(bytes).split("\0")[0];
  try {
    for (;;) {
      const header = await read(512);
      if (header.every((byte) => byte === 0)) throw new Error("配布物に DESCRIPTION がありません。");
      const sizeField = string(header.subarray(124, 136)).trim();
      const checksum = string(header.subarray(148, 156)).trim();
      const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (!/^[0-7]+$/.test(sizeField) || !/^[0-7]+$/.test(checksum) || Number.parseInt(checksum, 8) !== sum) {
        throw new Error("tar ヘッダーを確認できません。");
      }
      const size = Number.parseInt(sizeField, 8);
      const shortName = string(header.subarray(0, 100));
      const prefix = string(header.subarray(345, 500));
      const name = (prefix ? prefix + "/" + shortName : shortName).replace(/^\.\//, "");
      if (name === packageName + "/DESCRIPTION" && [0, 48].includes(header[156])) {
        if (size > maxDescriptionBytes) throw new Error("DESCRIPTION が 256 KB を超えています。");
        return readDescription(decoder.decode(await read(size)));
      }
      await read(Math.ceil(size / 512) * 512, false);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function sha256Archive(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
