export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Profile {
  id: string;
  username: string | null;
  avatar_url: string | null;
  gemini_api_key_encrypted: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  characteristics: Json;
  appearance: Json;
  persona: Json;
  skills: string[] | Json;
  attributes: Json;
  avatar_asset_url: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface Content {
  id: string;
  user_id: string;
  entity_id: string | null;
  type: 'image' | 'video' | 'audio' | 'text';
  storage_path: string | null;
  public_url: string | null;
  metadata: Json;
  created_at: string;
}

export interface EntityCharacteristics {
  age?: string;
  role?: string;
  background?: string;
  [key: string]: unknown;
}

export interface EntityAppearance {
  description?: string;
  reference_image_urls?: string[];
  [key: string]: unknown;
}

export interface EntityPersona {
  tone?: string;
  style?: string;
  catchphrases?: string[];
  dialogue_examples?: string[];
  [key: string]: unknown;
}
