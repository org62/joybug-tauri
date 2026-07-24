import { useSessionContext } from '@/contexts/SessionContext';
import { BookmarksView } from '@/components/BookmarksView';

export function ContextBookmarksView() {
  const sessionData = useSessionContext();

  const {
    bookmarks,
    changedValueIds,
    removeBookmark,
    removeBookmarks,
    updateBookmark,
    setBookmarkValue,
    toggleLock,
  } = sessionData.bookmarkState;

  return (
    <BookmarksView
      bookmarks={bookmarks}
      changedValueIds={changedValueIds}
      onRemoveBookmark={removeBookmark}
      onRemoveBookmarks={removeBookmarks}
      onUpdateBookmark={updateBookmark}
      onSetValue={setBookmarkValue}
      onToggleLock={toggleLock}
      onNavigateToDisassembly={sessionData.onNavigateToDisassembly}
      onNavigateToMemory={sessionData.onNavigateToMemory}
      onFindAccesses={sessionData.onFindAccesses}
    />
  );
}
