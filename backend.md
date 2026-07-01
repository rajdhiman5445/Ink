# Cloud Synchronization Architecture

This document describes the design, database schema, and operational flows of the cloud synchronization system implemented in **Ink Writer**.

---

## 1. Design Philosophy

* **IndexedDB-First**: IndexedDB remains the primary source of truth. The application loads immediately from the local database at startup to ensure instant availability.
* **Non-Blocking Writes**: Typing and editing never block on network requests. Local saves occur instantly (180ms debounce), while cloud sync runs asynchronously in the background.
* **Single-User Scope**: Designed for a single user editing across devices. Last-write-wins (LWW) resolution is applied per chapter and for overall book settings.
* **Zero Editor Disruption**: No background sync can modify or re-render the editor while the user is focused or typing, preventing cursor jumps and text glitches.

---

## 2. Supabase Schema

The database consists of two tables in the `public` schema of Supabase. Row-Level Security (RLS) is disabled for simplified personal access via the client's public API key.

```sql
-- 1. Chapters Table
-- Stores individual chapter content, keyed by the local chapter UUID
create table public.chapters (
  id text primary key,
  content text not null default '',
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Book Metadata Table
-- Stores book-level configuration and active viewport information
create table public.book_metadata (
  id text primary key default 'main',
  current_chapter_id text,
  font_size integer,
  chapter_order jsonb,
  chapter_view_states jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
```

---

## 3. Core Operational Flows

### A. Startup Sequence (Race-Free Initialization)
1. **Load IndexedDB**: Reads state from IndexedDB.
2. **Handle Empty Local Cache**:
   * If IndexedDB is empty, it queries Supabase for existing metadata and chapters.
   * If remote data exists, it downloads it, populates IndexedDB, and matches remote timestamps.
   * If Supabase is also empty (or offline), it falls back to a fresh book state (`createEmptyState()`).
3. **Populate Editor**: Mounts the document text in the editor.
4. **Mark Complete**: Sets `readyRef.current = true`. Only now are user listeners and auto-saves enabled.
5. **Initial Sync**: Fired in the background to reconcile any difference between the local and remote copies.

### B. Auto-Save & Debounced Upload
1. **Keystroke Hook**: `handleInput` modifies the in-memory state, updates timestamps (`updated_at` for active chapter, `metadata_updated_at` for book), and calls `schedulePersist()`.
2. **Local Commit (180ms)**: After a 180ms delay without keystrokes, `persistNow()` commits the snapshot to IndexedDB.
3. **Cloud Synchronization Debounce (2000ms)**: Following a local commit, `scheduleCloudSync()` debounces the upload by **2 seconds**. This resets on further edits, ensuring uploads only occur when the user pauses.

### C. Background Polling & Event Pulls
To fetch changes made on other devices, `syncWithCloud()` is run on:
* A repeating **30-second interval** timer.
* When the window gains focus (the `'focus'` event listener).
* When the page becomes visible again (the `'visibilitychange'` event listener when state is `'visible'`).

---

## 4. Conflict Resolution & Merging

When `syncWithCloud` runs, it compares the local `stateRef.current` with fetched remote records:

### Metadata Sync
* If `local_metadata_updated_at > remote_metadata_updated_at`:
  * Local metadata wins. It is upserted to Supabase.
* If `remote_metadata_updated_at > local_metadata_updated_at`:
  * Remote metadata wins. Local settings (font size, view states) are updated to match.
  * **Viewport Protection**: The local `currentChapterId` is preserved and **never** overwritten by the remote selection. This keeps the user on their active chapter.

### Chapter Sync
The chapter order is defined by the winning metadata. For each chapter ID in the active order:
* **Exists in both**:
  * If `local_chapter.updated_at > remote_chapter.updated_at`, the local chapter is uploaded.
  * If `remote_chapter.updated_at > local_chapter.updated_at` (and content differs), the remote chapter is downloaded to local memory.
* **Exists only locally**: The chapter is uploaded to Supabase.
* **Exists only remotely**: The chapter is downloaded locally.
* **Deletions**: Any chapter row on Supabase whose ID is no longer present in the active metadata `chapter_order` is deleted.

---

## 5. Editor Safeguards (Zero-Overwriting UI)

If a background sync updates the local database while the browser is active:
* **Focused Mode**: If the user is currently editing (`document.activeElement === editorRef.current`), the app sets `isDeferredSyncUpdateRef.current = true`. The visual editor is **never** re-rendered or modified. Only non-disruptive variables (like font size) are updated.
* **Blur Apply**: The second the user leaves or clicks out of the editor, the `'blur'` event handler fires, clearing the deferred flag and refreshing the editor visually with the synced content.
* **Delta Rendering**: If the user is not editing, `renderCurrentChapter()` is only called if the active chapter's content, font size, or order index has actually changed.

---

## 6. Offline Queueing & Retry

* If a Supabase query fails due to network failure, the application catches the error and marks `isSyncPendingRef.current = true`.
* The status indicator shifts to `Sync offline`.
* The application listens for the window's `'online'` event. The moment connectivity returns, it automatically runs `syncWithCloud()` to push or pull pending edits.
