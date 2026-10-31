import mongoose from 'mongoose';
import type { AppConfig } from './types.js';
import type { ConfigStore } from './store.js';
import { DeviceModel, GpsPositionModel, GpsTrackPointModel, VehicleModel, pruneTrail } from './db.js';
import { resolveDisplayPlace } from './place.js';

export type GpsPing = {
  deviceId?: string;
  vehicleId?: string;
  registrationNumber?: string;
  lat: number;
  lng: number;
  batteryPercent?: number;
  odometerKm?: number;
  speedKmh?: number;
  ignition?: string;
  vendorType?: string;
  at?: Date;
};

export type IngestResult = {
  updated: boolean;
  deviceId: string | null;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  lastPlace: string | null;
  lastPlaceKind: 'Hub' | 'Location' | null;
  insideHub: boolean;
  lat: number;
  lng: number;
  storedIn: 'mongodb';
  message?: string;
};

function isCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 180;
}

export function normalizePing(input: Record<string, unknown>): GpsPing | null {
  const lat = Number(input.lat ?? input.latitude);
  const lng = Number(input.lng ?? input.lon ?? input.longitude);
  if (!isCoord(lat) || !isCoord(lng) || Math.abs(lat) > 90) return null;
  if (lat === 0 && lng === 0) return null;
  const deviceId = stringish(input.deviceId ?? input.imei ?? input.device);
  const vehicleId = stringish(input.vehicleId);
  const registrationNumber = stringish(input.registrationNumber ?? input.registration ?? input.name);
  if (!deviceId && !vehicleId && !registrationNumber) return null;
  const battery = input.batteryPercent ?? input.battery;
  const odometer = input.odometerKm ?? input.odometer;
  const speed = input.speedKmh ?? input.speed;
  return {
    deviceId,
    vehicleId,
    registrationNumber,
    lat,
    lng,
    batteryPercent: battery == null || battery === '' ? undefined : clampBattery(Number(battery)),
    odometerKm: odometer == null || odometer === '' ? undefined : toOdometerKm(Number(odometer)),
    speedKmh: speed == null || speed === '' ? undefined : Number.isFinite(Number(speed)) ? Number(speed) : undefined,
    ignition: stringish(input.ignition),
    at: input.at ? new Date(String(input.at)) : new Date(),
  };
}

function stringish(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function clampBattery(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return value;
}

function toOdometerKm(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (value > 10_000) return Math.round((value / 1000) * 100) / 100;
  return Math.round(value * 100) / 100;
}

export function parseTcpLine(line: string): GpsPing | null {
  const text = line.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return normalizePing(JSON.parse(text) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length < 3) return null;
  return normalizePing({
    deviceId: parts[0],
    lat: parts[1],
    lng: parts[2],
    batteryPercent: parts[3],
    odometerKm: parts[4],
  });
}

export async function touchDevice(
  imei: string,
  extras?: { ignition?: string; vendorType?: string },
): Promise<{ deviceId: string; updated: boolean }> {
  if (await isIgnoredImei(imei)) return { deviceId: imei, updated: false };
  const deviceId = await resolveDeviceId(imei);
  const existing = await DeviceModel.findOne({
    $or: [{ deviceId: { $in: deviceKeys(deviceId) } }, { imei: { $in: deviceKeys(imei) } }],
  }).select({ deviceId: 1 }).lean();
  if (!existing) return { deviceId, updated: false };
  await DeviceModel.collection.updateOne(
    { deviceId: existing.deviceId ?? deviceId },
    {
      $set: {
        lastSeenAt: new Date(),
        connectionStatus: 'Connected',
        imei,
        ...(extras?.ignition ? { ignition: extras.ignition } : {}),
      },
    },
  );
  return { deviceId: String(existing.deviceId ?? deviceId), updated: true };
}

export async function ingestPing(config: AppConfig, store: ConfigStore, ping: GpsPing): Promise<IngestResult> {
  const at = ping.at && !Number.isNaN(ping.at.getTime()) ? ping.at : new Date();
  if (ping.deviceId) ping.deviceId = await resolveDeviceId(ping.deviceId);
  if (ping.deviceId && (await isIgnoredImei(ping.deviceId))) {
    return {
      updated: false,
      deviceId: ping.deviceId,
      vehicleId: null,
      vehicleRegistration: null,
      lastPlace: null,
      lastPlaceKind: null,
      insideHub: false,
      lat: ping.lat,
      lng: ping.lng,
      storedIn: 'mongodb',
      message: 'Device was deleted; GPS is ignored',
    };
  }
  const deviceKey = ping.deviceId || ping.registrationNumber || ping.vehicleId;
  if (!deviceKey) {
    return {
      updated: false,
      deviceId: null,
      vehicleId: null,
      vehicleRegistration: null,
      lastPlace: null,
      lastPlaceKind: null,
      insideHub: false,
      lat: ping.lat,
      lng: ping.lng,
      storedIn: 'mongodb',
      message: 'deviceId, registrationNumber or vehicleId is required',
    };
  }

  const place = await resolveDisplayPlace(config, store, ping.lat, ping.lng);
  const vehicle = await resolveVehicle(ping);
  const deviceId = ping.deviceId ?? vehicle?.iotDeviceId;
  const trailBase = vehicle?.locationTrail as { lat: number; lng: number; at: Date }[] | undefined;
  const existingGps = await GpsPositionModel.findOne({ deviceKey });
  const trail = pruneTrail(existingGps?.locationTrail ?? trailBase, ping.lat, ping.lng, at, config.trailWindowMs);

  await upsertIgnoringDuplicate(GpsPositionModel, { deviceKey }, {
    deviceKey,
    deviceId,
    vehicleId: vehicle?._id?.toString() ?? ping.vehicleId,
    registrationNumber: vehicle?.registrationNumber ?? ping.registrationNumber,
    lat: ping.lat,
    lng: ping.lng,
    batteryPercent: ping.batteryPercent,
    odometerKm: ping.odometerKm,
    lastPlace: place.lastPlace,
    lastPlaceKind: place.lastPlaceKind,
    lastHubId: place.lastHubId,
    lastTelemetryAt: at,
    locationTrail: trail,
  });

  if (deviceId) {
    const vehicleId = vehicle?._id != null ? String(vehicle._id) : undefined;
    const vehicleTaken =
      vehicleId != null
        ? await DeviceModel.findOne({ vehicleId, deviceId: { $ne: deviceId } }).select({ deviceId: 1 }).lean()
        : null;
    const deviceSet: Record<string, unknown> = {
      lastLat: ping.lat,
      lastLng: ping.lng,
      lastSeenAt: at,
      connectionStatus: 'Connected',
      imei: ping.deviceId ?? deviceId,
      ...(vehicleId && !vehicleTaken ? { vehicleId } : {}),
      ...(ping.batteryPercent != null ? { batteryPercent: ping.batteryPercent } : {}),
      ...(ping.odometerKm != null ? { odometerKm: ping.odometerKm } : {}),
      ...(ping.speedKmh != null ? { speedKmh: ping.speedKmh } : {}),
      ...(ping.ignition ? { ignition: ping.ignition } : {}),
      ...(ping.vendorType ? { vendorType: ping.vendorType } : {}),
    };
    const existingDevice = (await DeviceModel.findOne({
      $or: [{ deviceId: { $in: deviceKeys(deviceId) } }, { imei: { $in: deviceKeys(deviceId) } }],
    })
      .select({ _id: 1, deviceId: 1 })
      .lean()) as { _id?: unknown } | null;
    if (existingDevice?._id) {
      await DeviceModel.collection.updateOne({ _id: existingDevice._id }, { $set: deviceSet });
    } else {
      await upsertIgnoringDuplicate(DeviceModel, { deviceId }, {
        ...deviceSet,
        deviceId,
        vendorType: ping.vendorType ?? 'WanWay',
      });
    }
  }

  if (vehicle) {
    const vehicleSet: Record<string, unknown> = {
      lastLat: ping.lat,
      lastLng: ping.lng,
      lastTelemetryAt: at,
      lastPlace: place.lastPlace,
      lastPlaceKind: place.lastPlaceKind,
      lastHubId: place.lastHubId ?? undefined,
      locationTrail: trail,
    };
    if (deviceId && vehicle.iotDeviceId !== deviceId) {
      const taken = await VehicleModel.findOne({ iotDeviceId: { $in: deviceKeys(deviceId) }, _id: { $ne: vehicle._id } })
        .select({ _id: 1 })
        .lean();
      if (!taken) vehicleSet.iotDeviceId = deviceId;
    }
    if (ping.batteryPercent != null && Number.isFinite(ping.batteryPercent)) vehicleSet.batteryPercent = ping.batteryPercent;
    if (ping.odometerKm != null && Number.isFinite(ping.odometerKm)) vehicleSet.odometerKm = ping.odometerKm;
    if (vehicle.status === 'Offline') vehicleSet.status = 'Available';
    if (ping.speedKmh != null) vehicleSet.speedKmh = ping.speedKmh;
    if (ping.ignition) vehicleSet.ignition = ping.ignition;
    await persistByEitherId(VehicleModel.collection, String(vehicle._id), vehicleSet);
    await GpsTrackPointModel.create({
      vehicleId: String(vehicle._id),
      deviceId,
      lat: ping.lat,
      lng: ping.lng,
      speedKmh: ping.speedKmh,
      ignition: ping.ignition,
      at,
    }).catch(() => undefined);
  }

  await forwardToPlatform(config, ping, deviceId);

  return {
    updated: true,
    deviceId: deviceId ?? null,
    vehicleId: vehicle?._id?.toString() ?? ping.vehicleId ?? null,
    vehicleRegistration: vehicle?.registrationNumber ?? ping.registrationNumber ?? null,
    lastPlace: place.lastPlace,
    lastPlaceKind: place.lastPlaceKind,
    insideHub: place.lastPlaceKind === 'Hub',
    lat: ping.lat,
    lng: ping.lng,
    storedIn: 'mongodb',
  };
}

async function isIgnoredImei(raw: string) {
  const keys = deviceKeys(raw);
  if (!keys.length) return false;
  const hit = await mongoose.connection.collection('iot_ignored_devices').findOne({ deviceKey: { $in: keys } });
  return Boolean(hit);
}

function deviceKeys(raw: string): string[] {
  const keys = new Set<string>();
  const value = String(raw ?? '').trim();
  if (value) keys.add(value);
  const digits = value.replace(/\D/g, '');
  if (digits) {
    keys.add(digits);
    if (digits.length === 16 && digits.startsWith('0')) keys.add(digits.slice(1));
    if (digits.length === 15) keys.add(`0${digits}`);
  }
  return [...keys];
}

async function resolveDeviceId(raw: string): Promise<string> {
  const keys = deviceKeys(raw);
  if (!keys.length) return raw;
  const found = await DeviceModel.findOne({
    $or: [{ deviceId: { $in: keys } }, { imei: { $in: keys } }],
  });
  return found?.deviceId ?? keys.find((k) => /^\d+$/.test(k)) ?? raw;
}

async function findByEitherId(id: string) {
  if (!id) return null;
  const asString = await VehicleModel.findOne({ $expr: { $eq: [{ $toString: '$_id' }, id] } });
  if (asString) return asString;
  if (mongoose.Types.ObjectId.isValid(id)) return VehicleModel.findById(id);
  return null;
}

async function persistByEitherId(
  collection: { updateOne: (filter: object, update: object) => Promise<{ matchedCount: number }> },
  id: string,
  set: Record<string, unknown>,
) {
  const filters: object[] = [{ $expr: { $eq: [{ $toString: '$_id' }, id] } }];
  if (mongoose.Types.ObjectId.isValid(id)) {
    try {
      filters.push({ _id: new mongoose.Types.ObjectId(id) });
    } catch {
      /* ignore */
    }
  }
  filters.push({ _id: id });
  for (const filter of filters) {
    const res = await collection.updateOne(filter, { $set: set });
    if (res.matchedCount) return;
  }
}

async function resolveVehicle(ping: GpsPing) {
  if (ping.vehicleId) {
    const byId = await findByEitherId(ping.vehicleId);
    if (byId) return byId;
  }
  if (ping.registrationNumber) {
    const byReg = await VehicleModel.findOne({ registrationNumber: ping.registrationNumber });
    if (byReg) return byReg;
  }
  if (ping.deviceId) {
    const keys = deviceKeys(ping.deviceId);
    const device = await DeviceModel.findOne({
      $or: [{ deviceId: { $in: keys } }, { imei: { $in: keys } }],
    });
    if (device?.vehicleId) {
      const byDeviceVehicle = await findByEitherId(String(device.vehicleId));
      if (byDeviceVehicle) return byDeviceVehicle;
    }
    const byIot = await VehicleModel.findOne({ iotDeviceId: { $in: keys } });
    if (byIot) return byIot;
  }
  return null;
}

async function forwardToPlatform(config: AppConfig, ping: GpsPing, deviceId?: string) {
  const base = config.platformApi.url.replace(/\/$/, '');
  if (!base || !deviceId) return;
  const path = config.platformApi.telemetryPath.startsWith('/')
    ? config.platformApi.telemetryPath
    : `/${config.platformApi.telemetryPath}`;
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        deviceId,
        lat: ping.lat,
        lng: ping.lng,
        batteryPercent: ping.batteryPercent,
        odometerKm: ping.odometerKm,
        speedKmh: ping.speedKmh,
        ignition: ping.ignition,
        name: ping.registrationNumber,
        vendorType: ping.vendorType,
      }),
    });
    if (!res.ok) {
      console.warn(`[platform telemetry] HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn(`[platform telemetry] ${error instanceof Error ? error.message : error}`);
  }
}

function isDuplicateKey(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000);
}

async function upsertIgnoringDuplicate(
  model: { findOneAndUpdate: (...args: never[]) => Promise<unknown> },
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  try {
    await (model.findOneAndUpdate as (filter: unknown, update: unknown, options: unknown) => Promise<unknown>)(
      filter,
      { $set: update },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    await (model.findOneAndUpdate as (filter: unknown, update: unknown, options: unknown) => Promise<unknown>)(
      filter,
      { $set: update },
      { upsert: false },
    );
  }
}
