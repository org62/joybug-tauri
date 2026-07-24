import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CustomTypeDef, TypeLayout, TypeSummary } from "@/lib/typeSystem";

export interface TebPeb {
  teb: string | null;
  peb: string | null;
}

/** Data layer for the type system: PDB type queries, memory reads for overlays,
 * and custom-type CRUD. All calls are OOB and work while Running/Paused/Open.
 * Stable identity per session: consumers key read effects on this object, so a
 * fresh literal per render would re-fire memory reads on every session update. */
export function useTypes(sessionId: string | undefined) {
  return useMemo(
    () => ({
      async searchTypes(filter: string, moduleBase?: string, maxResults = 500): Promise<TypeSummary[]> {
        if (!sessionId) return [];
        return invoke<TypeSummary[]>("list_session_types", {
          sessionId,
          moduleBase: moduleBase ?? null,
          filter: filter || null,
          maxResults,
        });
      },

      async getType(name: string, moduleBase?: string): Promise<TypeLayout | null> {
        if (!sessionId) return null;
        return invoke<TypeLayout | null>("get_session_type", {
          sessionId,
          name,
          moduleBase: moduleBase ?? null,
        });
      },

      async getTypeByIndex(moduleBase: string, index: number): Promise<TypeLayout | null> {
        if (!sessionId) return null;
        return invoke<TypeLayout | null>("get_session_type_by_index", {
          sessionId,
          moduleBase,
          index,
        });
      },

      async readMemory(address: string, size: number): Promise<Uint8Array | null> {
        if (!sessionId || size <= 0) return null;
        try {
          const bytes = await invoke<number[] | null>("read_memory_sync", { sessionId, address, size });
          return bytes && bytes.length ? Uint8Array.from(bytes) : null;
        } catch {
          return null;
        }
      },

      async getTebPeb(): Promise<TebPeb> {
        if (!sessionId) return { teb: null, peb: null };
        try {
          return await invoke<TebPeb>("get_session_teb_peb", { sessionId });
        } catch {
          return { teb: null, peb: null };
        }
      },

      async listCustomTypes(): Promise<CustomTypeDef[]> {
        return invoke<CustomTypeDef[]>("list_custom_types");
      },

      async saveCustomType(def: CustomTypeDef): Promise<CustomTypeDef> {
        return invoke<CustomTypeDef>("save_custom_type", { def });
      },

      async deleteCustomType(id: string): Promise<void> {
        await invoke("delete_custom_type", { id });
      },

      async parseCustomTypeText(text: string): Promise<CustomTypeDef> {
        return invoke<CustomTypeDef>("parse_custom_type_text", { text });
      },
    }),
    [sessionId],
  );
}

export type UseTypes = ReturnType<typeof useTypes>;
