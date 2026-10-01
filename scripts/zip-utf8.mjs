import fs from "node:fs";

// ZIP32 headers and the UTF-8 flag: PKWARE APPNOTE sections 4.3.7, 4.3.12 and D.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Native macOS zip may store UTF-8 bytes without marking their encoding.
// Set only the encoding flag after validating names and matching local headers;
// compressed data, offsets, sizes and CRC32 values remain unchanged.
export function ensureZipUTF8(file) {
  const buffer = fs.readFileSync(file);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = -1;
  for (
    let pos = buffer.length - 22;
    pos >= Math.max(0, buffer.length - 65557);
    --pos
  ) {
    if (
      buffer.readUInt32LE(pos) === 0x06054b50 &&
      pos + 22 + buffer.readUInt16LE(pos + 20) === buffer.length
    ) {
      end = pos;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP结束目录无效");
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    buffer.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize !== end
  )
    throw new Error("提交材料只支持完整单卷ZIP32归档");
  const names = [];
  let offset = directoryOffset;
  for (let i = 0; i < count; ++i) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("ZIP中央目录无效");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new Error("ZIP目录长度无效");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength);
    names.push(decoder.decode(name));
    decoder.decode(buffer.subarray(next - commentLength, next));
    const local = buffer.readUInt32LE(offset + 42);
    if (
      local + 30 + nameLength > directoryOffset ||
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 26) !== nameLength ||
      !buffer.subarray(local + 30, local + 30 + nameLength).equals(name) ||
      buffer.readUInt16LE(local + 6) !== buffer.readUInt16LE(offset + 8)
    )
      throw new Error("ZIP本地头与中央目录不一致");
    buffer.writeUInt16LE(buffer.readUInt16LE(offset + 8) | 0x0800, offset + 8);
    buffer.writeUInt16LE(buffer.readUInt16LE(local + 6) | 0x0800, local + 6);
    offset = next;
  }
  if (offset !== end) throw new Error("ZIP中央目录大小与记录数不一致");
  fs.writeFileSync(file, buffer);
  return names;
}
