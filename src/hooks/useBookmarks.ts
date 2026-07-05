import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ResolvedBookmark } from '@/contexts/SessionContext';

export type { ResolvedBookmark } from '@/contexts/SessionContext';

export interface AddBookmarkParams {
  kind: 'value' | 'pointer' | 'code';
  address: string;            // absolute address (hex) of the cell / static base
  valueType?: string;         // U8..F64 for value/pointer kinds
  name?: string;
  comment?: string;
  pointerOffsets?: string[];  // hex offsets for pointer kind
  baseSymbol?: string;
  asmText?: string;
}

interface BookmarksUpdatedPayload {
  session_id: string;
  bookmarks: ResolvedBookmark[];
}

export function useBookmarks(sessionId?: string, isPaused?: boolean, sessionBookmarks?: ResolvedBookmark[], isLive?: boolean) {
  const [bookmarks, setBookmarks] = useState<ResolvedBookmark[]>([]);

  const sessionBookmarksRef = useRef(sessionBookmarks);
  sessionBookmarksRef.current = sessionBookmarks;

  // Live count, read inside the running poll so it can skip the backend
  // round-trip when there's nothing to refresh (without re-arming the interval).
  const bookmarkCountRef = useRef(0);
  bookmarkCountRef.current = bookmarks.length;

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      await invoke('refresh_bookmarks', { sessionId });
    } catch {
      // Session may not be paused; ignore.
    }
  }, [sessionId]);

  // Session cleanup / seed + refresh live values when the session appears and
  // on pause transitions. Not gated on isPaused — a non-invasive Open session
  // never pauses but still has persisted bookmarks to show (and the live poll
  // below skips its refresh while the list is empty, so seeding matters).
  useEffect(() => {
    if (!sessionId) {
      setBookmarks([]);
      return;
    }
    if (sessionBookmarksRef.current) {
      setBookmarks(sessionBookmarksRef.current);
    }
    refresh();
  }, [sessionId, isPaused, refresh]);

  // Poll live values while the target runs (Running or non-invasive Open), like
  // the memory view. The backend reads out-of-band when not paused, so values
  // update without a pause.
  useEffect(() => {
    if (!sessionId || !isLive) return;
    const interval = setInterval(() => { if (bookmarkCountRef.current > 0) refresh(); }, 500);
    return () => clearInterval(interval);
  }, [sessionId, isLive, refresh]);

  // Listen for bookmarks-updated events.
  useEffect(() => {
    if (!sessionId) return;
    const unlisten = listen<BookmarksUpdatedPayload>('bookmarks-updated', (event) => {
      if (event.payload.session_id === sessionId) {
        setBookmarks(event.payload.bookmarks);
      }
    });
    return () => {
      unlisten.then(f => f());
    };
  }, [sessionId]);

  const addBookmark = useCallback(async (params: AddBookmarkParams) => {
    if (!sessionId) return;
    try {
      await invoke('add_bookmark', {
        sessionId,
        kind: params.kind,
        address: params.address,
        valueType: params.valueType ?? null,
        name: params.name ?? null,
        comment: params.comment ?? null,
        pointerOffsets: params.pointerOffsets ?? null,
        baseSymbol: params.baseSymbol ?? null,
        asmText: params.asmText ?? null,
      });
    } catch (e) {
      console.error('Failed to add bookmark:', e);
    }
  }, [sessionId]);

  const removeBookmark = useCallback(async (id: string) => {
    if (!sessionId) return;
    try {
      await invoke('remove_bookmark', { sessionId, id });
    } catch (e) {
      console.error('Failed to remove bookmark:', e);
    }
  }, [sessionId]);

  const removeBookmarks = useCallback(async (ids: string[]) => {
    if (!sessionId) return;
    try {
      await invoke('remove_bookmarks', { sessionId, ids });
    } catch (e) {
      console.error('Failed to remove bookmarks:', e);
    }
  }, [sessionId]);

  const updateBookmark = useCallback(async (
    id: string,
    fields: { name?: string | null; comment?: string | null; group?: string | null; valueType?: string | null },
  ) => {
    if (!sessionId) return;
    try {
      await invoke('update_bookmark', {
        sessionId,
        id,
        name: fields.name ?? null,
        comment: fields.comment ?? null,
        group: fields.group ?? null,
        valueType: fields.valueType ?? null,
      });
    } catch (e) {
      console.error('Failed to update bookmark:', e);
    }
  }, [sessionId]);

  const setBookmarkValue = useCallback(async (id: string, value: string) => {
    if (!sessionId) return;
    try {
      await invoke('set_bookmark_value', { sessionId, id, value });
    } catch (e) {
      console.error('Failed to set bookmark value:', e);
    }
  }, [sessionId]);

  const toggleLock = useCallback(async (id: string, locked: boolean) => {
    if (!sessionId) return;
    try {
      await invoke('toggle_bookmark_lock', { sessionId, id, locked });
    } catch (e) {
      console.error('Failed to toggle bookmark lock:', e);
    }
  }, [sessionId]);

  return useMemo(() => ({
    bookmarks,
    addBookmark,
    removeBookmark,
    removeBookmarks,
    updateBookmark,
    setBookmarkValue,
    toggleLock,
    refresh,
  }), [bookmarks, addBookmark, removeBookmark, removeBookmarks, updateBookmark, setBookmarkValue, toggleLock, refresh]);
}

export type BookmarkState = ReturnType<typeof useBookmarks>;
