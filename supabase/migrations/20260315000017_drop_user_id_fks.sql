-- Treat DB as "baby": drop foreign keys that tie user_id to profiles.
-- App handles ownership in code; user_id can be from app_users or auth (profiles).
-- Run this after 20260315000016_app_users_and_sessions.

alter table if exists public.entities
  drop constraint if exists entities_user_id_fkey;

alter table if exists public.content
  drop constraint if exists content_user_id_fkey;

alter table if exists public.conversations
  drop constraint if exists conversations_user_id_fkey;

alter table if exists public.messages
  drop constraint if exists messages_user_id_fkey;

alter table if exists public.memories
  drop constraint if exists memories_user_id_fkey;

alter table if exists public.conversation_summaries
  drop constraint if exists conversation_summaries_user_id_fkey;

alter table if exists public.skill_outputs
  drop constraint if exists skill_outputs_user_id_fkey;
