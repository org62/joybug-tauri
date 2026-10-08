import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError } from '@/lib/logger';
import { formatTauriError, isBenignSessionError } from '@/lib/sessionHelpers';

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

export interface ImageOptionalHeader {
  Magic: number;
  MajorLinkerVersion: number;
  MinorLinkerVersion: number;
  SizeOfCode: number;
  SizeOfInitializedData: number;
  SizeOfUninitializedData: number;
  AddressOfEntryPoint: number;
  BaseOfCode: number;
  /** PE32 only; absent (null) in PE32+ where ImageBase widens into this slot. */
  BaseOfData?: number | null;
  /** Widened to 64 bits for both formats; PE32 values fit in 32. */
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

export interface NtHeaders {
  Signature: number;
  FileHeader: ImageFileHeader;
  OptionalHeader: ImageOptionalHeader;
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
  nt_headers: NtHeaders;
  sections: ImageSectionHeader[];
  imports: ImportDescriptorInfo[];
  exports: ExportInfo | null;
  // Present in the backend payload; optional here for backward compatibility.
  dos_header?: DosHeader;
  runtime_functions?: RuntimeFunction[] | null;
  /** RVAs of the TLS callbacks (empty when the module has none). */
  tls_callbacks?: number[];
  /** An ELF module's headers as they really are; the PE-shaped fields above
   *  are synthesized from them (see `joybug_core::elf::info`). Absent for PE. */
  elf?: ElfInfo | null;
}

// ---- ELF (joybug_core::pe_types::ElfInfo) ----

export interface ElfHeader {
  class: number;
  data: number;
  os_abi: number;
  abi_version: number;
  e_type: number;
  e_machine: number;
  e_version: number;
  e_entry: number;
  e_phoff: number;
  e_shoff: number;
  e_flags: number;
  e_ehsize: number;
  e_phentsize: number;
  e_phnum: number;
  e_shentsize: number;
  e_shnum: number;
  e_shstrndx: number;
}

export interface ElfProgramHeader {
  p_type: number;
  p_flags: number;
  p_offset: number;
  p_vaddr: number;
  p_paddr: number;
  p_filesz: number;
  p_memsz: number;
  p_align: number;
}

export interface ElfSectionHeader {
  name: string;
  sh_type: number;
  sh_flags: number;
  sh_addr: number;
  sh_offset: number;
  sh_size: number;
  sh_link: number;
  sh_info: number;
  sh_addralign: number;
  sh_entsize: number;
}

export interface ElfDynamicEntry {
  tag: number;
  value: number;
  /** The `.dynstr` string for NEEDED / SONAME / RPATH / RUNPATH. */
  string?: string | null;
}

/** Addresses are link-time VAs; `rva = va - min_vaddr`. */
export interface ElfInfo {
  header: ElfHeader;
  program_headers: ElfProgramHeader[];
  sections: ElfSectionHeader[];
  dynamic: ElfDynamicEntry[];
  needed: string[];
  soname?: string | null;
  interp?: string | null;
  rpath?: string | null;
  runpath?: string | null;
  build_id?: string | null;
  debuglink?: string | null;
  min_vaddr: number;
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
  canUseMemoryOps: boolean,
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
      if (!isBenignSessionError(msg)) {
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
          if (!isBenignSessionError(msg)) {
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
    if (moduleBase && canUseMemoryOps && sessionId) {
      fetchModuleInfo(moduleBase);
    }
  }, [moduleBase, canUseMemoryOps, sessionId, fetchModuleInfo]);

  // Session cleanup: clear state when the session ends or its process goes away
  useEffect(() => {
    if (!sessionId || !canUseMemoryOps) {
      setInfo(null);
      setError(null);
      setIsLoading(false);
      lastRequestedBase.current = null;
    }
  }, [sessionId, canUseMemoryOps]);

  return { info, isLoading, error };
}
