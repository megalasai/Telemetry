import type { AppConfig } from './types.js';
import type { ConfigStore } from './store.js';

export type LocationPing = { lat: number; lng: number; at: Date };

export type PlaceResult = {
  lastPlace: string;
  lastPlaceKind: 'Hub' | 'Location';
  lastHubId: string | null;
};

type ReverseMatch = {
  locality?: string;
  district?: string;
  state?: string;
  postalCode?: string;
};

type HubRow = { id: string; name: string; lat: number; lng: number; radiusM: number };

let hubCache: { at: number; hubs: HubRow[] } | null = null;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function containingHub(hubs: HubRow[], lat: number, lng: number): HubRow | null {
  let best: { hub: HubRow; distance: number } | null = null;
  for (const hub of hubs) {
    const distance = haversineMeters(lat, lng, hub.lat, hub.lng);
    if (distance <= hub.radiusM && (!best || distance < best.distance)) {
      best = { hub, distance };
    }
  }
  return best?.hub ?? null;
}

export async function reversePlaceName(config: AppConfig, lat: number, lng: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.locationApi.timeoutMs);
  try {
    const url = new URL(config.locationApi.path, `${config.locationApi.url}/`);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lng));
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(config.locationApi.apiKey ? { 'X-Api-Key': config.locationApi.apiKey } : {}),
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ReverseMatch;
    const parts = [data.locality, data.district, data.state, data.postalCode].filter(
      (part): part is string => Boolean(part && part.trim()),
    );
    const unique: string[] = [];
    for (const part of parts) {
      if (!unique.includes(part)) unique.push(part);
    }
    return unique.length ? unique.join(', ') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveDisplayPlace(config: AppConfig, store: ConfigStore, lat: number, lng: number): Promise<PlaceResult> {
  const now = Date.now();
  if (!hubCache || now - hubCache.at >= config.hubCacheMs) {
    hubCache = {
      at: now,
      hubs: store.listHubs().filter((h) => h.status !== 'Inactive'),
    };
  }
  const hub = containingHub(hubCache.hubs, lat, lng);
  if (hub) {
    return { lastPlace: hub.name, lastPlaceKind: 'Hub', lastHubId: hub.id };
  }
  const place = await reversePlaceName(config, lat, lng);
  return {
    lastPlace: place ?? 'Unknown location',
    lastPlaceKind: 'Location',
    lastHubId: null,
  };
}

export function invalidateHubCache(): void {
  hubCache = null;
}
