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

---

## 6. Challenge: Empty Chapter Deletion & Fallback Overwrite (Data Loss)

### The Symptom
Creating a new empty chapter (e.g., Chapter 10) and then immediately closing or refreshing the tab would sometimes cause the new chapter to disappear. Additionally, upon reopening, the application would default back to Chapter 1, and Chapter 1's content would be wiped out (empty).

### The Diagnostic
1. **Unawaited IndexedDB Writes**: The background sync updated the `synced: true` flag and called `writeState` to IndexedDB, but this write promise was not awaited. The UI showed "Synced", the user closed the tab, and the browser aborted the incomplete write. On restart, the mismatch made the startup sync believe Chapter 10 was deleted on another device, removing it.
2. **Missing Active Chapter Fallback**: Because Chapter 10 was deleted, `getCurrentChapterIndex` returned `-1` (not found). The function had a fallback to index `0` (Chapter 1).
3. **Empty DOM Overwrite**: On tab close (`pagehide`), `persistNow()` called `captureCurrentChapterState()`. Since the browser was unloading, the editor DOM text content returned empty `""`. Because of the fallback, this empty text was written to **Chapter 1**, wiping out all of Chapter 1's data.

### The Fix
* **Awaited Synced Writes**: Made the sync promise chain await `writeState(...)` before resolving and displaying "Synced".
* **Removed Fallback & Early Abort**: Modified `getCurrentChapterIndex` to return `-1` if the chapter is missing. Updated `captureCurrentChapterState()` and `handleInput()` to return early and abort if the index is `< 0`, preventing any out-of-sync DOM reads from overwriting Chapter 1.
* **Skip DOM Reads on Unload**: Set the `pagehide` and `visibilitychange` (hidden) events to skip DOM text reading (`skipCapture`), writing the in-memory state directly to prevent reading blank unloading elements.

---

## 7. Challenge: Automatic Startup Focus Blocking Sync

### The Symptom
Writing edits on Device B today, then opening Device A (which was closed yesterday) would result in Device A loading yesterday's version from local storage and refusing to pull/overwrite it with today's cloud updates.

### The Diagnostic
* When Device A mounted, `renderCurrentChapter()` automatically focused the editor to allow immediate typing.
* The startup background sync finished, saw the remote today's version was newer, and prepared to update the editor.
* However, because the editor was automatically focused, `document.activeElement === editor` evaluated to `true` (`isEditing`). The sync engine deferred the update to avoid disrupting the user.
* Since the user hadn't typed but the sync was deferred, they remained looking at yesterday's local text.

### The Fix
* Introduced a `hasTypedRef` tracker. It is set to `true` when the user triggers a keystroke (`handleInput`) and reset to `false` on blur or chapter transitions.
* Modified the sync deferral check to only defer if the user has actually typed: `const isUserTyping = isEditing && hasTypedRef.current;`.
* On startup, the automatic focus is ignored (since they haven't typed yet), allowing the cloud update to load immediately.
