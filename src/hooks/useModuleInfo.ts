import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError } from '@/lib/logger';
import { formatTauriError } from '@/lib/sessionHelpers';

// TypeScript interfaces mirroring joybug_core::pe_types

export interface ImageDataDirectory {
  VirtualAddress: number;
  Size: number;
}

export interface DosHeader {
  e_magic: number;
  e_lfanew: number;
  // Other DOS fields exist in the payload but aren't surfaced in the UI.
}

export interface RuntimeFunction {
  BeginAddress: number;
  EndAddress: number;
  UnwindData: number;
}

export interface ImageFileHeader {
  Machine: number;
  NumberOfSections: number;
  TimeDateStamp: number;
  PointerToSymbolTable: number;
  NumberOfSymbols: number;
  SizeOfOptionalHeader: number;
  Characteristics: number;
}

export interface ImageOptionalHeader64 {
  Magic: number;
  MajorLinkerVersion: number;
  MinorLinkerVersion: number;
  SizeOfCode: number;
  SizeOfInitializedData: number;
  SizeOfUninitializedData: number;
  AddressOfEntryPoint: number;
  BaseOfCode: number;
  ImageBase: number;
  SectionAlignment: number;
  FileAlignment: number;
  MajorOperatingSystemVersion: number;
  MinorOperatingSystemVersion: number;
  MajorImageVersion: number;
  MinorImageVersion: number;
  MajorSubsystemVersion: number;
  MinorSubsystemVersion: number;
  Win32VersionValue: number;
  SizeOfImage: number;
  SizeOfHeaders: number;
  CheckSum: number;
  Subsystem: number;
  DllCharacteristics: number;
  SizeOfStackReserve: number;
  SizeOfStackCommit: number;
  SizeOfHeapReserve: number;
  SizeOfHeapCommit: number;
  LoaderFlags: number;
  NumberOfRvaAndSizes: number;
  DataDirectory: ImageDataDirectory[];
}

export interface NtHeaders64 {
  Signature: number;
  FileHeader: ImageFileHeader;
  OptionalHeader: ImageOptionalHeader64;
}

export interface ImageSectionHeader {
  Name: number[];
  VirtualSize: number;
  VirtualAddress: number;
  SizeOfRawData: number;
  PointerToRawData: number;
  PointerToRelocations: number;
  PointerToLinenumbers: number;
  NumberOfRelocations: number;
  NumberOfLinenumbers: number;
  Characteristics: number;
}

export type ImportItem =
  | { ByName: { name: string; hint: number } }
  | { ByOrdinal: { ordinal: number } };

export type ImportKind =
  | { Item: ImportItem }
  | { Error: string };

export interface ImportEntry {
  iat_rva: number;
  kind: ImportKind;
}

export interface ImportDescriptorInfo {
  dll_name: string;
  entries: ImportEntry[];
}

export type ExportKind =
  | { Symbol: { rva: number } }
  | { Forward: { target: string } }
  | { Error: string };

export interface ExportEntry {
  ordinal: number;
  name: string | null;
  kind: ExportKind;
}

export interface ExportInfo {
  dll_name: string;
  ordinal_base: number;
  entries: ExportEntry[];
}

export interface ModuleExtraInfo {
  nt_headers: NtHeaders64;
  sections: ImageSectionHeader[];
  imports: ImportDescriptorInfo[];
  exports: ExportInfo | null;
  // Present in the backend payload; optional here for backward compatibility.
  dos_header?: DosHeader;
  runtime_functions?: RuntimeFunction[] | null;
}

interface ModuleExtraInfoResult {
  session_id: string;
  module_base: string;
  info: ModuleExtraInfo;
}

interface ModuleExtraInfoError {
  session_id: string;
  module_base: string;
  error: string;
}

export function useModuleInfo(
  sessionId: string | undefined,
  moduleBase: string | null,
  isPaused: boolean,
) {
  const [info, setInfo] = useState<ModuleExtraInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRequestedBase = useRef<string | null>(null);

  const fetchModuleInfo = useCallback(async (base: string) => {
    if (!sessionId) return;
    lastRequestedBase.current = base;
    setIsLoading(true);
    setError(null);
    setInfo(null);

    try {
      await invoke('request_module_extra_info', {
        sessionId,
        moduleBase: base,
      });
    } catch (err) {
      const msg = formatTauriError(err);
      if (!msg.includes('InvalidSessionState') && !msg.includes('must be paused')) {
        setError(msg);
        toastError(`Failed to request module info: ${msg}`, sessionId);
      }
      setIsLoading(false);
    }
  }, [sessionId]);

  // Listen for events
  useEffect(() => {
    if (!sessionId) return;

    const unlistenSuccess = listen<ModuleExtraInfoResult>(
      'module-extra-info-updated',
      (event) => {
        if (event.payload.session_id === sessionId && event.payload.module_base === lastRequestedBase.current) {
          setInfo(event.payload.info);
          setIsLoading(false);
          setError(null);
        }
      }
    );

    const unlistenError = listen<ModuleExtraInfoError>(
      'module-extra-info-error',
      (event) => {
        if (event.payload.session_id === sessionId && event.payload.module_base === lastRequestedBase.current) {
          const msg = event.payload.error || '';
          if (!msg.includes('InvalidSessionState') && !msg.includes('must be paused')) {
            setError(msg);
            toastError(`Module info failed: ${msg}`, sessionId);
          }
          setIsLoading(false);
        }
      }
    );

    return () => {
      unlistenSuccess.then(u => u());
      unlistenError.then(u => u());
    };
  }, [sessionId]);

  // Fetch when moduleBase changes
  useEffect(() => {
    if (moduleBase && isPaused && sessionId) {
      fetchModuleInfo(moduleBase);
    }
  }, [moduleBase, isPaused, sessionId, fetchModuleInfo]);

  // Session cleanup: clear state when session ends or resumes
  useEffect(() => {
    if (!sessionId || !isPaused) {
      setInfo(null);
      setError(null);
      setIsLoading(false);
      lastRequestedBase.current = null;
    }
  }, [sessionId, isPaused]);

  return { info, isLoading, error };
}
