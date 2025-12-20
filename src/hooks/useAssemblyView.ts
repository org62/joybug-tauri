import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError } from '@/lib/logger';
import {
  parseAddressExpression,
  RegisterContext,
  SymbolResolver,
} from '@/lib/hexUtils';

// Instruction interface matching backend SerializableInstruction
export interface Instruction {
  address: string;
  symbol: string;
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_jump: boolean;
  is_call: boolean;
  is_ret: boolean;
  jump_target: string | null;
}

// Event payloads from Tauri
interface FunctionDisassemblyResult {
  session_id: string;
  address: number;
  instructions: Instruction[];
  function_start: string | null;
  function_end: string | null;
  function_name: string | null;
}

interface FunctionDisassemblyError {
  session_id: string;
  address: number;
  error: string;
}

// Settings stored in localStorage
interface AssemblyViewSettings {
  showBytes: boolean;
}

const SETTINGS_KEY = 'assembly-view-settings';
const MAX_HISTORY_SIZE = 50;
// Fallback limit when function bounds aren't available
// The backend will use actual function bounds when possible
const DEFAULT_MAX_INSTRUCTIONS = 2000;

function loadSettings(): AssemblyViewSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load assembly view settings:', e);
  }
  return { showBytes: true };
}

function saveSettings(settings: AssemblyViewSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save assembly view settings:', e);
  }
}

export interface AssemblyViewState {
  instructions: Instruction[];
  currentAddress: bigint | null;
  pcAddress: bigint | null;
  functionStart: bigint | null;
  functionEnd: bigint | null;
  functionName: string | null;
  isLoading: boolean;
  error: string | null;
  showBytes: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Address to highlight temporarily (after navigation)
  jumpTargetAddress: bigint | null;
}

export interface AssemblyViewActions {
  goToAddress: (expression: string) => Promise<void>;
  goToAddressDirect: (address: bigint) => void;
  scrollToAddressInView: (address: bigint) => void;
  goBack: () => void;
  goForward: () => void;
  refresh: () => void;
  toggleBytesColumn: () => void;
  scrollToPC: () => void;
}

export interface UseAssemblyViewOptions {
  sessionId: string | undefined;
  pcAddress?: number; // Current PC from debug event
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
}

export function useAssemblyView(options: UseAssemblyViewOptions): AssemblyViewState & AssemblyViewActions {
  const { sessionId, pcAddress: pcAddressProp, registers = {}, resolveSymbol } = options;

  // State
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [currentAddress, setCurrentAddress] = useState<bigint | null>(null);
  const [functionStart, setFunctionStart] = useState<bigint | null>(null);
  const [functionEnd, setFunctionEnd] = useState<bigint | null>(null);
  const [functionName, setFunctionName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBytes, setShowBytes] = useState(() => loadSettings().showBytes);
  // Address to highlight temporarily after navigation (for jump targets)
  const [jumpTargetAddress, setJumpTargetAddress] = useState<bigint | null>(null);

  // Navigation history
  const [navigationHistory, setNavigationHistory] = useState<bigint[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Refs
  const lastRequestedAddress = useRef<bigint | null>(null);
  const scrollToPCRef = useRef<(() => void) | null>(null);
  // Track the last PC we auto-navigated to, to detect when PC actually changes (stepping)
  const lastAutoPcAddress = useRef<bigint | null>(null);
  // Track if user manually navigated away from PC
  const userNavigatedAway = useRef<boolean>(false);

  // Derived PC address
  const pcAddress = pcAddressProp != null ? BigInt(pcAddressProp) : null;

  // Computed
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < navigationHistory.length - 1;

  // Load disassembly for an address
  const loadDisassembly = useCallback(async (address: bigint) => {
    if (!sessionId) return;

    lastRequestedAddress.current = address;
    setIsLoading(true);
    setError(null);

    try {
      await invoke('request_function_disassembly', {
        sessionId,
        address: Number(address),
        maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
      });
      setCurrentAddress(address);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Ignore expected errors when session is running
      if (!errorMessage.includes('InvalidSessionState') && !errorMessage.includes('must be paused')) {
        console.error('Failed to request function disassembly:', err);
        setError(errorMessage);
        toastError(`Failed to request disassembly: ${errorMessage}`, sessionId);
      }
      setIsLoading(false);
    }
  }, [sessionId]);

  // Go to address with history management
  // isAutoNavigation: true when called by the PC-following effect, false for user actions
  const goToAddressDirect = useCallback((address: bigint, isAutoNavigation = false) => {
    // Mark that user navigated away from PC (unless this is auto-navigation)
    if (!isAutoNavigation) {
      userNavigatedAway.current = true;
      // Set jump target for highlighting and scrolling
      setJumpTargetAddress(address);
    } else {
      // Auto-navigation (following PC) - no jump target highlight
      setJumpTargetAddress(null);
    }

    // Add to history
    setNavigationHistory(prev => {
      // Truncate forward history if we're not at the end
      const truncated = prev.slice(0, historyIndex + 1);
      // Add new address
      const updated = [...truncated, address];
      // Limit size
      if (updated.length > MAX_HISTORY_SIZE) {
        return updated.slice(-MAX_HISTORY_SIZE);
      }
      return updated;
    });
    setHistoryIndex(prev => Math.min(prev + 1, MAX_HISTORY_SIZE - 1));

    loadDisassembly(address);
  }, [historyIndex, loadDisassembly]);

  // Scroll to address already in view (no history, no reload)
  const scrollToAddressInView = useCallback((address: bigint) => {
    setJumpTargetAddress(address);
  }, []);

  // Go to address with expression parsing
  const goToAddress = useCallback(async (expression: string) => {
    if (!expression.trim()) return;

    const result = await parseAddressExpression(expression, registers, resolveSymbol);
    if (result.address === null) {
      toastError(result.error || 'Invalid address expression', sessionId);
      return;
    }

    goToAddressDirect(result.address);
  }, [registers, resolveSymbol, goToAddressDirect, sessionId]);

  // Navigate back
  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const newIndex = historyIndex - 1;
    const targetAddress = navigationHistory[newIndex];
    setHistoryIndex(newIndex);
    setJumpTargetAddress(targetAddress);
    loadDisassembly(targetAddress);
  }, [canGoBack, historyIndex, navigationHistory, loadDisassembly]);

  // Navigate forward
  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    const targetAddress = navigationHistory[newIndex];
    setHistoryIndex(newIndex);
    setJumpTargetAddress(targetAddress);
    loadDisassembly(targetAddress);
  }, [canGoForward, historyIndex, navigationHistory, loadDisassembly]);

  // Refresh current view
  const refresh = useCallback(() => {
    if (currentAddress !== null) {
      loadDisassembly(currentAddress);
    } else if (pcAddress !== null) {
      loadDisassembly(pcAddress);
    }
  }, [currentAddress, pcAddress, loadDisassembly]);

  // Toggle bytes column
  const toggleBytesColumn = useCallback(() => {
    setShowBytes(prev => {
      const newValue = !prev;
      saveSettings({ showBytes: newValue });
      return newValue;
    });
  }, []);

  // Scroll to PC (placeholder - actual implementation in component)
  const scrollToPC = useCallback(() => {
    if (scrollToPCRef.current) {
      scrollToPCRef.current();
    }
  }, []);

  // Listen for disassembly events
  useEffect(() => {
    if (!sessionId) return;

    const unlistenSuccess = listen<FunctionDisassemblyResult>(
      'function-disassembly-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setInstructions(event.payload.instructions);
          setFunctionStart(event.payload.function_start ? BigInt(event.payload.function_start) : null);
          setFunctionEnd(event.payload.function_end ? BigInt(event.payload.function_end) : null);
          setFunctionName(event.payload.function_name);
          setIsLoading(false);
          setError(null);
        }
      }
    );

    const unlistenError = listen<FunctionDisassemblyError>(
      'function-disassembly-error',
      (event) => {
        if (event.payload.session_id === sessionId) {
          const msg = event.payload.error || '';
          if (!msg.includes('InvalidSessionState') && !msg.includes('must be paused')) {
            setError(msg);
            toastError(`Disassembly failed: ${msg}`, sessionId);
          }
          setIsLoading(false);
        }
      }
    );

    // Also listen for the old event for backwards compatibility
    const unlistenOldSuccess = listen<{session_id: string, address: number, instructions: Instruction[]}>(
      'disassembly-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setInstructions(event.payload.instructions);
          setFunctionStart(null);
          setFunctionEnd(null);
          setFunctionName(null);
          setIsLoading(false);
          setError(null);
        }
      }
    );

    return () => {
      unlistenSuccess.then(unlisten => unlisten());
      unlistenError.then(unlisten => unlisten());
      unlistenOldSuccess.then(unlisten => unlisten());
    };
  }, [sessionId]);

  // Auto-load when PC changes (stepping)
  // When user steps, ALWAYS follow PC regardless of where they were looking
  useEffect(() => {
    if (pcAddress === null || !sessionId) return;

    // Detect if PC actually changed (i.e., user stepped)
    const pcActuallyChanged = lastAutoPcAddress.current === null || pcAddress !== lastAutoPcAddress.current;

    // Initial load - no address set yet or no navigation history
    if (currentAddress === null || navigationHistory.length === 0) {
      lastAutoPcAddress.current = pcAddress;
      userNavigatedAway.current = false;
      goToAddressDirect(pcAddress, true);
      return;
    }

    // If PC actually changed (user stepped), always follow PC
    if (pcActuallyChanged) {
      lastAutoPcAddress.current = pcAddress;
      userNavigatedAway.current = false;
      // Clear any previous jump target so PC scroll effect can work
      setJumpTargetAddress(null);

      // Check if PC is outside current function bounds - need to load new function
      const pcOutsideFunction = functionStart === null || functionEnd === null ||
        pcAddress < functionStart || pcAddress >= functionEnd;

      if (pcOutsideFunction) {
        // PC moved to different function - load it
        goToAddressDirect(pcAddress, true);
      }
      // If PC is still in current function, scroll effect will handle scrolling to it
    }
    // If PC didn't change, user can freely navigate without being pulled back
  }, [pcAddress, sessionId, currentAddress, navigationHistory.length, functionStart, functionEnd, goToAddressDirect]);

  // Clear state when session changes or session stops (pcAddress becomes null)
  useEffect(() => {
    if (!sessionId || pcAddress === null) {
      setInstructions([]);
      setCurrentAddress(null);
      setFunctionStart(null);
      setFunctionEnd(null);
      setFunctionName(null);
      setError(null);
      setIsLoading(false);
      setNavigationHistory([]);
      setHistoryIndex(-1);
      lastAutoPcAddress.current = null;
      userNavigatedAway.current = false;
    }
  }, [sessionId, pcAddress]);

  return {
    // State
    instructions,
    currentAddress,
    pcAddress,
    functionStart,
    functionEnd,
    functionName,
    isLoading,
    error,
    showBytes,
    canGoBack,
    canGoForward,
    jumpTargetAddress,
    // Actions
    goToAddress,
    goToAddressDirect,
    scrollToAddressInView,
    goBack,
    goForward,
    refresh,
    toggleBytesColumn,
    scrollToPC,
  };
}
