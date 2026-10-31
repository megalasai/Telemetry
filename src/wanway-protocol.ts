/** WanWay GPS Protocol 2024.1.19 V3 (GT06 0x7878 / 0x7979). */

export type WanwayFix = {
  imei: string;
  lat?: number;
  lng?: number;
  speedKmh?: number;
  ignition?: string;
  course?: number;
  gpsValid?: boolean;
  at?: Date;
  kind: 'login' | 'gps' | 'heartbeat' | 'alarm' | 'ascii' | 'lbs' | 'info';
};

export type WanwayParseResult = {
  consumed: number;
  replies: Buffer[];
  fixes: WanwayFix[];
};

const START_SHORT = 0x78;
const START_LONG = 0x79;
const STOP_A = 0x0d;
const STOP_B = 0x0a;

const PROTO_LOGIN = 0x01;
const PROTO_GPS = 0x12;
const PROTO_HEARTBEAT = 0x13;
const PROTO_ALARM = 0x16;
const PROTO_STRING = 0x21;
const PROTO_GPS_UTC = 0x22;
const PROTO_LBS_ONLY = 0x24;
const PROTO_ALARM_UTC = 0x26;
const PROTO_TIMEZONE = 0x27;
const PROTO_SOS_ADDR = 0x2a;
const PROTO_WIFI = 0x2c;
const PROTO_GPS_4G = 0xa0;
const PROTO_GENERAL = 0x94;

type BinaryFrame = {
  size: number;
  serial: Buffer;
  protocol: number;
  info: Buffer;
  extended: boolean;
};

export function crc16Itu(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1;
    }
  }
  return ~crc & 0xffff;
}

export function decodeBcdImei(raw: Buffer): string {
  let out = '';
  for (const byte of raw) {
    out += ((byte >> 4) & 0x0f).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  out = out.replace(/[^0-9]/g, '');
  if (out.startsWith('0') && out.length === 16) out = out.slice(1);
  return out;
}

function coordFromGt06(raw: number, negative: boolean): number {
  const deg = raw / 1_800_000;
  if (!Number.isFinite(deg)) return NaN;
  return negative ? -deg : deg;
}

function bcdDate(buf: Buffer, offset: number): Date | undefined {
  if (buf.length < offset + 6) return undefined;
  const y = ((buf[offset] >> 4) * 10 + (buf[offset] & 0x0f)) + 2000;
  const mo = (buf[offset + 1] >> 4) * 10 + (buf[offset + 1] & 0x0f);
  const d = (buf[offset + 2] >> 4) * 10 + (buf[offset + 2] & 0x0f);
  const h = (buf[offset + 3] >> 4) * 10 + (buf[offset + 3] & 0x0f);
  const mi = (buf[offset + 4] >> 4) * 10 + (buf[offset + 4] & 0x0f);
  const s = (buf[offset + 5] >> 4) * 10 + (buf[offset + 5] & 0x0f);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(dt.getTime()) ? undefined : dt;
}

/** Server ACK: 78 78 05 {proto} {serial} {crc} 0D 0A (or 79 79 00 05 … for 0x7979). */
export function buildAck(protocol: number, serial: Buffer, extended = false): Buffer {
  const s0 = serial[0] ?? 0;
  const s1 = serial[1] ?? 0;
  if (extended) {
    const body = Buffer.from([0x00, 0x05, protocol, s0, s1]);
    const crc = crc16Itu(body);
    return Buffer.from([START_LONG, START_LONG, 0x00, 0x05, protocol, s0, s1, crc >> 8, crc & 0xff, STOP_A, STOP_B]);
  }
  const body = Buffer.from([0x05, protocol, s0, s1]);
  const crc = crc16Itu(body);
  return Buffer.from([START_SHORT, START_SHORT, 0x05, protocol, s0, s1, crc >> 8, crc & 0xff, STOP_A, STOP_B]);
}

function parseGpsBlock(info: Buffer, imei: string, kind: WanwayFix['kind']): WanwayFix {
  if (info.length < 18) return { imei, kind };
  const at = bcdDate(info, 0);
  const latRaw = info.readUInt32BE(7);
  const lngRaw = info.readUInt32BE(11);
  const speed = info[15];
  const courseStatus = info.readUInt16BE(16);
  const south = Boolean(courseStatus & 0x0400);
  const west = Boolean(courseStatus & 0x0800);
  const gpsValid = Boolean(courseStatus & 0x1000);
  const course = courseStatus & 0x03ff;
  const lat = coordFromGt06(latRaw, south);
  const lng = coordFromGt06(lngRaw, west);
  const accOffset = 18 + 2 + 1 + 2 + 3;
  const ignition = info.length > accOffset ? (info[accOffset] ? 'ON' : 'OFF') : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { imei, kind, gpsValid: false, at, ignition };
  }
  return { imei, lat, lng, speedKmh: speed, course, gpsValid, at, kind, ignition };
}

function parseInformation(protocol: number, info: Buffer, imei: string): WanwayFix | null {
  if (protocol === PROTO_LOGIN) {
    const id = decodeBcdImei(info.subarray(0, Math.min(8, info.length)));
    return { imei: id || imei, kind: 'login' };
  }
  if (protocol === PROTO_HEARTBEAT) {
    const terminal = info[0] ?? 0;
    return { imei, kind: 'heartbeat', ignition: terminal & 0x02 ? 'ON' : 'OFF' };
  }
  if (protocol === PROTO_LBS_ONLY || protocol === PROTO_TIMEZONE || protocol === PROTO_WIFI || protocol === PROTO_STRING || protocol === PROTO_GENERAL) {
    return { imei, kind: protocol === PROTO_LBS_ONLY ? 'lbs' : 'info' };
  }
  if (
    protocol === PROTO_GPS ||
    protocol === PROTO_GPS_UTC ||
    protocol === PROTO_ALARM ||
    protocol === PROTO_ALARM_UTC ||
    protocol === PROTO_GPS_4G ||
    protocol === PROTO_SOS_ADDR
  ) {
    const kind = protocol === PROTO_ALARM || protocol === PROTO_ALARM_UTC ? 'alarm' : 'gps';
    return parseGpsBlock(info, imei, kind);
  }
  return imei ? { imei, kind: 'info' } : null;
}

function parseBinaryFrame(buf: Buffer, offset: number): BinaryFrame | null {
  if (buf.length - offset < 10) return null;
  const a = buf[offset];
  const b = buf[offset + 1];
  if (a === START_SHORT && b === START_SHORT) {
    const length = buf[offset + 2];
    if (length < 5) return { size: 1, serial: Buffer.alloc(2), protocol: 0, info: Buffer.alloc(0), extended: false };
    const size = 5 + length;
    if (buf.length - offset < size) return null;
    if (buf[offset + size - 2] !== STOP_A || buf[offset + size - 1] !== STOP_B) {
      return { size: 1, serial: Buffer.alloc(2), protocol: 0, info: Buffer.alloc(0), extended: false };
    }
    const content = buf.subarray(offset + 3, offset + 3 + length - 2);
    const protocol = content[0] ?? 0;
    const info = content.subarray(1, Math.max(1, content.length - 2));
    const serial = content.subarray(content.length - 2);
    return { size, serial: Buffer.from(serial), protocol, info: Buffer.from(info), extended: false };
  }
  if (a === START_LONG && b === START_LONG) {
    if (buf.length - offset < 11) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 5) return { size: 1, serial: Buffer.alloc(2), protocol: 0, info: Buffer.alloc(0), extended: true };
    const size = 6 + length;
    if (buf.length - offset < size) return null;
    if (buf[offset + size - 2] !== STOP_A || buf[offset + size - 1] !== STOP_B) {
      return { size: 1, serial: Buffer.alloc(2), protocol: 0, info: Buffer.alloc(0), extended: true };
    }
    const content = buf.subarray(offset + 4, offset + 4 + length - 2);
    const protocol = content[0] ?? 0;
    const info = content.subarray(1, Math.max(1, content.length - 2));
    const serial = content.subarray(content.length - 2);
    return { size, serial: Buffer.from(serial), protocol, info: Buffer.from(info), extended: true };
  }
  return null;
}

function nmeaToDeg(raw: string, hemi: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const deg = Math.floor(abs / 100);
  const min = abs - deg * 100;
  let out = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') out = -out;
  return out;
}

export function parseAsciiHq(text: string): WanwayFix | null {
  const start = text.indexOf('*HQ,');
  if (start < 0) return null;
  const end = text.indexOf('#', start);
  if (end < 0) return null;
  const parts = text.slice(start + 1, end).split(',');
  if (parts.length < 3 || parts[0] !== 'HQ') return null;
  const imei = (parts[1] ?? '').replace(/\D/g, '');
  if (!imei) return null;
  const cmd = (parts[2] ?? '').toUpperCase();
  const fix: WanwayFix = { imei, kind: cmd === 'HT' || cmd === 'KN' ? 'heartbeat' : 'ascii' };
  if (parts.length >= 10) {
    const lat = nmeaToDeg(parts[5] ?? '', parts[6] ?? '');
    const lng = nmeaToDeg(parts[7] ?? '', parts[8] ?? '');
    const speed = Number(parts[9]);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      fix.lat = lat;
      fix.lng = lng;
      fix.kind = 'gps';
      fix.gpsValid = (parts[4] ?? 'A') === 'A';
    }
    if (Number.isFinite(speed)) fix.speedKmh = speed;
  }
  return fix;
}

function asciiAck(imei: string): Buffer {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return Buffer.from(`*HQ,${imei},V4,${stamp}#`, 'ascii');
}

export function parseWanwayBuffer(buffer: Buffer, boundImei = ''): WanwayParseResult {
  const replies: Buffer[] = [];
  const fixes: WanwayFix[] = [];
  let consumed = 0;
  let imei = boundImei;

  const hasBinary = buffer.includes(START_SHORT) || buffer.includes(START_LONG);
  if (!hasBinary) {
    const ascii = buffer.toString('ascii');
    if (ascii.includes('*HQ,')) {
      const hash = ascii.indexOf('#');
      if (hash >= 0) {
        const fix = parseAsciiHq(ascii);
        if (fix) {
          fixes.push(fix);
          if (fix.imei) imei = fix.imei;
          replies.push(asciiAck(imei));
        }
        consumed = Math.min(buffer.length, hash + 1);
        return { consumed, replies, fixes };
      }
    }
  }

  while (consumed < buffer.length) {
    const start = buffer.indexOf(START_SHORT, consumed);
    const start79 = buffer.indexOf(START_LONG, consumed);
    let at = -1;
    if (start >= 0 && start79 >= 0) at = Math.min(start, start79);
    else at = start >= 0 ? start : start79;
    if (at < 0) {
      consumed = buffer.length;
      break;
    }
    if (at > consumed) consumed = at;
    const frame = parseBinaryFrame(buffer, consumed);
    if (!frame) break;
    if (frame.size <= 1 || frame.protocol === 0) {
      consumed += 1;
      continue;
    }
    consumed += frame.size;
    const fix = parseInformation(frame.protocol, frame.info, imei);
    if (fix) {
      if (fix.imei) imei = fix.imei;
      else fix.imei = imei;
      fixes.push(fix);
    }
    replies.push(buildAck(frame.protocol, frame.serial, frame.extended));
  }

  return { consumed, replies, fixes };
}

export function isGpsFix(fix: WanwayFix): fix is WanwayFix & { lat: number; lng: number } {
  return fix.lat != null && fix.lng != null && Number.isFinite(fix.lat) && Number.isFinite(fix.lng);
}
