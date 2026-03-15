'use client';

export type GuestEntity = {
  id: string;
  name: string;
  slug: string;
};

export type GuestContent = {
  id: string;
  type: string;
  public_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  entity_id: string | null;
};

const ENTITIES_KEY = 'potaeto_guest_entities_v1';
const CONTENT_KEY = 'potaeto_guest_content_v1';

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function loadGuestEntities(): GuestEntity[] {
  if (typeof window === 'undefined') return [];
  return safeParse<GuestEntity[]>(window.localStorage.getItem(ENTITIES_KEY), []);
}

export function saveGuestEntities(entities: GuestEntity[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ENTITIES_KEY, JSON.stringify(entities));
}

export function loadGuestContent(): GuestContent[] {
  if (typeof window === 'undefined') return [];
  return safeParse<GuestContent[]>(window.localStorage.getItem(CONTENT_KEY), []);
}

export function saveGuestContent(content: GuestContent[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CONTENT_KEY, JSON.stringify(content));
}

export function addGuestEntity(partial: Omit<GuestEntity, 'id'> & { id?: string }): GuestEntity {
  const id = partial.id ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()));
  const entities = loadGuestEntities();
  const entity: GuestEntity = {
    id,
    name: partial.name,
    slug: partial.slug,
  };
  const existingIndex = entities.findIndex((e) => e.id === id);
  if (existingIndex >= 0) {
    entities[existingIndex] = entity;
  } else {
    entities.unshift(entity);
  }
  saveGuestEntities(entities);
  return entity;
}

export function updateGuestEntity(id: string, updates: Partial<Omit<GuestEntity, 'id'>>): GuestEntity | null {
  const entities = loadGuestEntities();
  const idx = entities.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const updated: GuestEntity = { ...entities[idx], ...updates, id };
  entities[idx] = updated;
  saveGuestEntities(entities);
  return updated;
}

export function getGuestEntityById(id: string): GuestEntity | null {
  const entities = loadGuestEntities();
  return entities.find((e) => e.id === id) ?? null;
}

export function addGuestContent(partial: Omit<GuestContent, 'id' | 'created_at'> & { id?: string; created_at?: string }): GuestContent {
  const id = partial.id ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()));
  const createdAt = partial.created_at ?? new Date().toISOString();
  const content = loadGuestContent();
  const row: GuestContent = {
    id,
    type: partial.type,
    public_url: partial.public_url ?? null,
    metadata: partial.metadata ?? {},
    created_at: createdAt,
    entity_id: partial.entity_id ?? null,
  };
  content.unshift(row);
  saveGuestContent(content);
  return row;
}

export function listGuestContentByEntity(entityId: string | null): GuestContent[] {
  const content = loadGuestContent();
  if (!entityId) return content;
  return content.filter((c) => c.entity_id === entityId);
}

export function listAllGuestContent(): GuestContent[] {
  return loadGuestContent();
}


