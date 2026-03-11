import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatTauriError } from '@/lib/sessionHelpers';

export interface PinnedAddress {
  address_hex: string;
  module_name: string | null;
  value_type: string;
  label: string | null;
  is_resolved: boolean;
}

interface AddPinResult {
  pinned: boolean;
  in_module: boolean;
}

export function usePinnedAddresses(sessionId: string | undefined) {
  const [pinnedAddresses, setPinnedAddresses] = useState<PinnedAddress[]>([]);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setPinnedAddresses([]);
      return;
    }
    try {
      const result = await invoke<PinnedAddress[]>('get_pinned_addresses', { sessionId });
      setPinnedAddresses(result);
    } catch {
      // Session may not exist yet
    }
  }, [sessionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addPin = useCallback(async (addressHex: string, valueType: string, label?: string): Promise<AddPinResult> => {
    if (!sessionId) return { pinned: false, in_module: false };
    try {
      const result = await invoke<AddPinResult>('add_pinned_address', {
        sessionId,
        addressHex,
        valueType,
        label: label ?? null,
      });
      if (result.pinned) {
        await reload();
      }
      return result;
    } catch (e) {
      console.error('Failed to pin address:', formatTauriError(e));
      return { pinned: false, in_module: false };
    }
  }, [sessionId, reload]);

  const confirmPinRaw = useCallback(async (addressHex: string, valueType: string, label?: string) => {
    if (!sessionId) return;
    try {
      await invoke('confirm_pin_raw_address', {
        sessionId,
        addressHex,
        valueType,
        label: label ?? null,
      });
      await reload();
    } catch (e) {
      console.error('Failed to pin raw address:', formatTauriError(e));
    }
  }, [sessionId, reload]);

  const removePin = useCallback(async (addressHex: string, moduleName?: string | null) => {
    if (!sessionId) return;
    try {
      const result = await invoke<PinnedAddress[]>('remove_pinned_address', {
        sessionId,
        addressHex,
        moduleName: moduleName ?? null,
      });
      setPinnedAddresses(result);
    } catch (e) {
      console.error('Failed to remove pinned address:', formatTauriError(e));
    }
  }, [sessionId]);

  return { pinnedAddresses, addPin, confirmPinRaw, removePin };
}
