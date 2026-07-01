# PROJECT

## Project Purpose
`Ink Writer` is a single-user novel writing web app. It is designed to be a calm, distraction-free place to draft long-form fiction with minimal interface noise and strong local ownership of the writing.

The current codebase focuses on:
- one writing surface
- multiple chapters
- browser-local persistence
- export for user-owned backups

It intentionally avoids collaboration, auth, cloud sync, AI assistance, formatting tools, and editor complexity that would pull attention away from writing.

## Philosophy
- One user only.
- Keep the UI almost invisible.
- Preserve writing flow over feature breadth.
- Prefer local-first storage and browser-native behavior.
- Keep chapter navigation and export lightweight.
- Avoid abstractions that do not directly help the writing experience.

The editor is meant to feel like opening a notebook, not operating a content management app.

## Current Architecture
The application is a small React app built with Vite. The implementation is intentionally imperative in places where that keeps typing and navigation fast.

### Runtime Shape
- `src/main.jsx` mounts a single React app with `createRoot`.
- The actual writing surface is a `contenteditable="plaintext-only"` element.
- Most state is stored in refs rather than React state to avoid re-renders while typing.
- React state is only used for UI that must re-render:
  - current chapter index
  - stats overlay visibility
  - chapter picker visibility
  - delete confirmation visibility

### Persistence Flow
- The current book is stored in IndexedDB.
- A legacy localStorage document is imported once if IndexedDB is empty.
- Saving is debounced while typing.
- The app also persists on page hide and visibility changes.

### Data Flow
- The current chapter content lives in the contenteditable surface.
- On input, the current chapter is copied into the in-memory book model.
- The same book model is serialized to IndexedDB.
- The current chapter’s cursor/selection and page scroll position are tracked per chapter and restored when switching chapters.

## Technologies Used
- React 19
- Vite 6
- JSZip for browser-side ZIP export
- IndexedDB for persistent storage
- Plain browser DOM APIs for selection, scroll, download, and modal behavior

## Folder Structure
- `index.html` - Vite entry HTML.
- `src/main.jsx` - App logic, book model, IndexedDB integration, export, chapter picker, stats overlay, and editor behavior.
- `src/styles.css` - All styling for the editor, chrome, overlay, modal, and responsive behavior.
- `package.json` - Scripts and dependencies.
- `package-lock.json` - Locked dependency tree.
- `vite.config.js` - Vite configuration.
- `.gitignore` - Local development and build artifacts.
- `vercel.json` - Vercel deployment configuration.

## Data Model
The persisted model is a single `Book` object.

### Book
Stored as the single record in IndexedDB under the key `book`.

Fields:
- `chapters`: ordered list of chapters
- `currentChapterId`: id of the currently open chapter
- `fontSize`: current editor font size
- `chapterViewStateById`: per-chapter view state used to restore cursor and scroll position

### Chapter
Each chapter stores only:
- `id`
- `content`

Chapter titles are not stored. The chapter number is derived from array order.

### Per-Chapter View State
The app also stores chapter-local UI state in memory and persists it inside the same book object:
- `selectionStart`
- `selectionEnd`
- `scrollTop`

This is what allows the app to reopen a chapter where the user left off.

## IndexedDB Storage Format
- Database name: `still-here`
- Database version: `1`
- Object store: `state`
- Record key: `book`

Stored value shape:

```json
{
  "chapters": [
    { "id": "chapter-id", "content": "..." }
  ],
  "currentChapterId": "chapter-id",
  "fontSize": 22,
  "chapterViewStateById": {
    "chapter-id": {
      "selectionStart": 0,
      "selectionEnd": 0,
      "scrollTop": 0
    }
  }
}
```

### Migration
On first load, if IndexedDB has no saved book, the app tries to migrate from the legacy localStorage key:
- `still-here.chapter1.session`

That legacy format contained:
- `text`
- `fontSize`
- `selectionStart`
- `selectionEnd`
- `scrollTop`

## Keyboard Shortcuts
### Chapter Navigation
- `Alt + N` - create a new chapter after the current one and switch to it
- `Alt + K` - previous chapter
- `Alt + L` - next chapter

### Word Count Overlay
- `Alt + C` - toggle the small word count overlay
- `Escape` - close the word count overlay, chapter picker, or delete confirmation if open

### Export
- `Alt + E` - export the book

### Font Size
- `+` and `-` buttons exist in the chrome
- `Alt + +`, `Alt + =`, `Alt + -`, `Alt + _` adjust font size

Note: the app’s shortcut handling is currently keyed off `Alt` for chapter navigation and font size adjustments.

## Existing Features
- Single distraction-free editor surface.
- Dark theme.
- Inter typography.
- Centered writing column.
- Long-form writing layout tuned for reading.
- Multiple chapters.
- Chapter picker modal triggered from the chapter indicator.
- Chapter creation.
- Chapter deletion with confirmation.
- Autosave to IndexedDB.
- Restore current chapter, cursor position, and page scroll after reload.
- Live word counts:
  - current chapter
  - entire book
- Small stats overlay toggled by `Alt + C`.
- Export to:
  - one Markdown file for the whole book
  - one ZIP archive with one Markdown file per chapter
- Minimal save indicator in the bottom-right corner.

## Features Intentionally Not Implemented
- Authentication
- Multi-user support
- Collaboration
- Cloud sync
- AI features
- Formatting toolbar
- Rich text formatting
- Sidebar
- Chapter titles
- Search
- Reordering chapters
- Chapter deletion from anywhere except the picker
- Settings pages
- Preview mode
- Publish flow
- Server-side APIs
- Database backend outside the browser
- Thumbnails
- Icons for chapter list items
- Metadata display in the chapter picker
- Analytics
- Comments

## Coding Principles
- Keep the editor fast and immediate.
- Avoid React state for keystroke-heavy data.
- Store only the minimum required structure.
- Prefer direct DOM APIs when they better preserve typing feel.
- Keep UI additions minimal and unobtrusive.
- Persist locally and deterministically.
- Preserve user content and cursor position above everything else.
- Do not introduce architecture that only exists to look “clean” on paper.

## UI Philosophy
- The writing area should dominate.
- Chrome should stay visually subordinate.
- The chapter label acts as the primary navigation entry point.
- Modals are small and functional, not decorative.
- No permanent sidebar.
- No editor toolbar.
- No extra panels unless they directly support writing or ownership.
- Keep the page feeling like a document, not an application dashboard.

## Deployment
- Built with Vite.
- Designed to deploy to Vercel as a static app.
- `vercel.json` configures:
  - `npm run build`
  - `dist` as the output directory

## Remaining Roadmap

- [x] Editor
- [x] Typography
- [x] Autosave
- [x] IndexedDB
- [x] Chapters
- [x] Chapter picker
- [x] Word count
- [x] Export
- [ ] Import -> not yet required
- [ ] Cloud sync

The app is currently centered on the basics that exist today.

If future work is requested, likely next steps would be:
- chapter renaming
- chapter reordering
- chapter search
- chapter import
- stronger backup and recovery flows

Those are not implemented now and should be treated as future work only if explicitly requested.

## Practical Notes For Future Agents
- Do not replace the contenteditable surface with a textarea unless you are prepared to preserve the current writing behavior.
- Do not change the scroll model casually; the current document-like scrolling is deliberate.
- Avoid moving state into React if it would introduce typing lag.
- Any chapter feature must preserve:
  - current chapter restore
  - per-chapter cursor restore
  - per-chapter scroll restore
  - IndexedDB persistence

