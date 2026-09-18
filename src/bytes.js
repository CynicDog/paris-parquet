// Byte-level primitives: a cursor over a Uint8Array with thrift-compact
// varint/zigzag reads, plus the shared UTF-8 decoder instance.

export const utf8 = new TextDecoder("utf-8");

export class Cursor {
  constructor(bytes, pos) {
    this.b = bytes;
    this.p = pos || 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  byte() { return this.b[this.p++]; }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  /** unsigned LEB128; uses float math so values above 2^31 stay correct */
  uvarint() {
    let shift = 1, out = 0, b;
    do { b = this.b[this.p++]; out += (b & 0x7f) * shift; shift *= 128; } while (b & 0x80);
    return out;
  }
  zigzag() { const v = this.uvarint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
}
