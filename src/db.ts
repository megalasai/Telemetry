import mongoose, { Schema } from 'mongoose';

const pingSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const vehicleSchema = new Schema(
  {
    registrationNumber: String,
    status: String,
    batteryPercent: Number,
    odometerKm: Number,
    iotDeviceId: String,
    lastLat: Number,
    lastLng: Number,
    lastTelemetryAt: Date,
    lastPlace: String,
    lastPlaceKind: String,
    lastHubId: String,
    locationTrail: { type: [pingSchema], default: [] },
  },
  { collection: 'vehicles', timestamps: true },
);

const deviceSchema = new Schema(
  {
    deviceId: { type: String, required: true, unique: true },
    vehicleId: String,
    vendorType: { type: String, default: 'GpsIngest' },
    connectionStatus: { type: String, default: 'Unknown' },
    lastSeenAt: Date,
    batteryPercent: Number,
    lastLat: Number,
    lastLng: Number,
    odometerKm: Number,
    imei: String,
    speedKmh: Number,
    ignition: String,
  },
  { collection: 'iot_devices', timestamps: true },
);

const gpsSchema = new Schema(
  {
    deviceKey: { type: String, required: true, unique: true },
    deviceId: String,
    vehicleId: String,
    registrationNumber: String,
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    batteryPercent: Number,
    odometerKm: Number,
    lastPlace: String,
    lastPlaceKind: String,
    lastHubId: String,
    lastTelemetryAt: Date,
    locationTrail: { type: [pingSchema], default: [] },
  },
  { collection: 'gps_positions', timestamps: true },
);

export const VehicleModel = mongoose.models.TelemetryVehicle ?? mongoose.model('TelemetryVehicle', vehicleSchema);
export const DeviceModel = mongoose.models.TelemetryDevice ?? mongoose.model('TelemetryDevice', deviceSchema);
export const GpsPositionModel = mongoose.models.GpsPosition ?? mongoose.model('GpsPosition', gpsSchema);

export async function connectMongo(uri: string): Promise<void> {
  await mongoose.connect(uri, { family: 4, serverSelectionTimeoutMS: 15000 });
  await relaxConflictingIndexes();
}

async function relaxConflictingIndexes() {
  await dropUniqueIfPresent('iot_devices', 'vehicleId');
  await DeviceModel.collection.createIndex({ deviceId: 1 }, { unique: true }).catch(() => undefined);
  await DeviceModel.collection.createIndex({ vehicleId: 1 }, { sparse: true }).catch(() => undefined);
  await GpsPositionModel.collection.createIndex({ deviceKey: 1 }, { unique: true }).catch(() => undefined);
}

async function dropUniqueIfPresent(collection: string, field: string) {
  const col = mongoose.connection.collection(collection);
  try {
    const indexes = await col.indexes();
    for (const index of indexes) {
      const keys = index.key as Record<string, number>;
      if (index.unique && keys && Object.keys(keys).length === 1 && keys[field] === 1) {
        await col.dropIndex(index.name as string);
      }
    }
  } catch {
    /* index may not exist yet */
  }
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export function pruneTrail(
  points: { lat: number; lng: number; at: Date }[] | undefined,
  lat: number,
  lng: number,
  at: Date,
  windowMs: number,
) {
  const cutoff = at.getTime() - windowMs;
  const next = (points ?? []).filter((p) => new Date(p.at).getTime() >= cutoff);
  const last = next[next.length - 1];
  if (last && Math.abs(last.lat - lat) < 0.000005 && Math.abs(last.lng - lng) < 0.000005) {
    last.at = at;
    return next;
  }
  next.push({ lat, lng, at });
  return next;
}

export async function listMongoPositions() {
  const docs = await GpsPositionModel.find().sort({ lastTelemetryAt: -1 }).lean();
  return docs.map((row) => ({
    deviceId: row.deviceId,
    vehicleId: row.vehicleId,
    registrationNumber: row.registrationNumber,
    lat: row.lat,
    lng: row.lng,
    lastPlace: row.lastPlace,
    lastPlaceKind: row.lastPlaceKind,
    lastHubId: row.lastHubId,
    at: row.lastTelemetryAt,
    trail: row.locationTrail ?? [],
  }));
}
