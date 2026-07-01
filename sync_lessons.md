# Sync Implementation Lessons & Troubleshooting

This document chronicles the specific bugs, regressions, and architectural challenges encountered during the implementation of the cloud synchronization feature in **Ink Writer**, along with their diagnostic processes and final resolutions.

---

## 1. Regression: Cursor Jumping & Text Resetting

### The Symptom
While typing, the cursor would periodically jump to the beginning of the line, or the current text selection would clear, disrupting the writing flow.

### The Diagnostic
* The synchronization logic compared local vs. remote metadata timestamps (`localUpdatedAt` and `remoteUpdatedAt`).
* When both were in sync (timestamps were equal), the logic fell through to the `else` block, which incorrectly set `localUpdated = true`.
* Consequently, on every 30-second poll or window focus sync tick, the app executed `renderCurrentChapter()`, which unconditionally overwrote the DOM editor's `textContent`.
* Overwriting `textContent` on a focused contenteditable element destroys the browser selection state and undo history.

### The Fix
* Corrected the metadata check to only flag `localUpdated = true` if the remote metadata was strictly newer (`remoteUpdatedAt > localUpdatedAt`). If timestamps are equal, the metadata is skipped.
* Implemented delta rendering: `renderCurrentChapter()` is only called if the active chapter's content or settings have changed.

---

## 2. Regression: Stalled Cloud Uploads (Data Not Syncing)

### The Symptom
Supabase rows were created on startup, but subsequent content updates typed in the editor failed to propagate to the cloud database.

### The Diagnostic
* Keystrokes instantly updated the chapter's content in the in-memory state inside `handleInput`.
* The timestamp update, however, was deferred to `captureCurrentChapterState()`, which ran 180ms later during local persistence.
* Because `captureCurrentChapterState()` compared the *already updated* memory chapter content with the editor text, `prevContent !== content` was always `false`. The `updated_at` timestamp was never modified, leading the sync engine to believe the chapter had no edits.

### The Fix
* Moved the timestamp updates (`updated_at` for chapters and `metadata_updated_at` for metadata) directly inside the `handleInput` keypress handler. Timestamps now increment immediately at the millisecond the content actually changes.

---

## 3. Challenge: Initialization Race Condition (Cloud Overwrites)

### The Symptom
Opening the application on a fresh browser tab with a completely empty local IndexedDB would overwrite and delete existing data in the cloud.

### The Diagnostic
* When local storage was empty, `init()` generated a new blank book locally via `createEmptyState()`, assigning it a current timestamp (`Date.now()`).
* Since `Date.now()` was newer than the timestamp of the existing data in Supabase, the startup background sync evaluated the blank local book as the "newest" version and uploaded it, overwriting the actual book content.

### The Fix
* Guarded `syncWithCloud` so it immediately returns if initialization is not complete (`readyRef.current === false`).
* Restructured `init()` to check Supabase for remote metadata and chapters *before* generating a new local state. If remote data exists, it is downloaded, populated in IndexedDB, and initialized with its original timestamps. Only then is `readyRef.current` set to `true`.

---

## 4. Challenge: Viewport Cross-Over (Active Chapter Jumping)

### The Symptom
If Device A edited Chapter 3, Device B (currently viewing Chapter 1) would automatically jump and replace its screen content with the text of Chapter 3 during background sync.

### The Diagnostic
* The `currentChapterId` was being synchronized as part of the shared metadata row.
* When Device B adopted the newer metadata from the cloud, its in-memory `localState.currentChapterId` was overwritten to Chapter 3.
* The visual renderer then updated the editor to display the new current chapter, forcibly changing the active view for the user on Device B.

### The Fix
* Preserved the local `currentChapterId` during metadata pulls. Devices now maintain their own local active chapter viewport.
* If a background sync updates other chapters (e.g., Chapter 3 is updated while the user is reading Chapter 1), the text changes are saved silently to IndexedDB. The editor for Chapter 1 remains completely untouched. When the user later navigates to Chapter 3, they see the synced text.

---

## 5. Challenge: Editor Safeguard (Deferring Sync Updates)

### The Symptom
Even if the active chapter's content is updated from the cloud, performing a text replacement in the DOM while a user is typing causes cursor stuttering.

### The Diagnostic
* Directly editing the DOM of a focused text input is disruptive, even when scroll offsets are restored.

### The Fix
* Added a deferred update state: if `localUpdated = true` but the editor is focused (`document.activeElement === editorRef.current`), the app flags `isDeferredSyncUpdateRef.current = true` and holds off re-rendering the editor.
* Attached a `'blur'` listener to the editor. When focus leaves the editor (e.g., when the user pauses and clicks away or switches chapters), the deferred updates are instantly applied, ensuring the screen is always current without disrupting active writing.
