import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import './styles.css';

const DB_NAME = 'still-here';
const DB_VERSION = 1;
const STORE_NAME = 'state';
const RECORD_KEY = 'book';
const LEGACY_STORAGE_KEY = 'still-here.chapter1.session';

const DEFAULT_FONT_SIZE = 22;
const MIN_FONT_SIZE = 16;
const MAX_FONT_SIZE = 28;
const SAVE_DELAY_MS = 180;

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function formatChapterNumber(index) {
  return `Chapter ${index + 1}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildBookMarkdown(state) {
  return state.chapters
    .map((chapter, index) => `# Chapter ${index + 1}\n\n${chapter.content || ''}`.trimEnd())
    .join('\n\n');
}

async function exportBook(state) {
  const markdown = buildBookMarkdown(state);
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), 'book.md');

  const zip = new JSZip();
  state.chapters.forEach((chapter, index) => {
    zip.file(`Chapter ${index + 1}.md`, chapter.content || '');
  });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, 'chapters.zip');
}

function exportCurrentChapter(state) {
  const index = getCurrentChapterIndex(state);
  const chapter = state.chapters[index];
  if (!chapter) {
    return;
  }
  const filename = `Chapter ${index + 1}.md`;
  downloadBlob(new Blob([chapter.content || ''], { type: 'text/markdown;charset=utf-8' }), filename);
}


function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `chapter_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createChapter(content = '') {
  return { id: createId(), content };
}

function createEmptyState() {
  const chapter = createChapter('');
  return {
    chapters: [{ ...chapter, updated_at: Date.now() }],
    currentChapterId: chapter.id,
    fontSize: DEFAULT_FONT_SIZE,
    chapterViewStateById: {
      [chapter.id]: {
        selectionStart: 0,
        selectionEnd: 0,
        scrollTop: 0,
      },
    },
    metadata_updated_at: Date.now(),
  };
}

function normalizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  const rawChapters = Array.isArray(source.chapters) ? source.chapters : [];
  const chapters = rawChapters
    .map((chapter) => ({
      id: typeof chapter?.id === 'string' && chapter.id ? chapter.id : createId(),
      content: typeof chapter?.content === 'string' ? chapter.content : '',
      updated_at: Number(chapter?.updated_at) || Date.now(),
    }))
    .filter(Boolean);

  if (chapters.length === 0) {
    return createEmptyState();
  }

  const chapterViewStateById = {};
  const rawViewState = source.chapterViewStateById && typeof source.chapterViewStateById === 'object' ? source.chapterViewStateById : {};
  for (const chapter of chapters) {
    const viewState = rawViewState[chapter.id] && typeof rawViewState[chapter.id] === 'object' ? rawViewState[chapter.id] : {};
    chapterViewStateById[chapter.id] = {
      selectionStart: Math.max(0, Number(viewState.selectionStart) || 0),
      selectionEnd: Math.max(0, Number(viewState.selectionEnd) || 0),
      scrollTop: Math.max(0, Number(viewState.scrollTop) || 0),
    };
  }

  const currentChapterId = chapters.some((chapter) => chapter.id === source.currentChapterId)
    ? source.currentChapterId
    : chapters[0].id;

  return {
    chapters,
    currentChapterId,
    fontSize: clamp(Number(source.fontSize) || DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE),
    chapterViewStateById,
    metadata_updated_at: Number(source.metadata_updated_at) || Date.now(),
  };
}

function getCurrentChapterIndex(state) {
  const index = state.chapters.findIndex((chapter) => chapter.id === state.currentChapterId);
  return index >= 0 ? index : 0;
}

function getCurrentChapter(state) {
  return state.chapters[getCurrentChapterIndex(state)] ?? state.chapters[0];
}

function getSelectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { selectionStart: 0, selectionEnd: 0 };
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return { selectionStart: 0, selectionEnd: 0 };
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);

  return {
    selectionStart: startRange.toString().length,
    selectionEnd: endRange.toString().length,
  };
}

function setSelectionOffsets(root, start, end) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  const textNode = root.firstChild;

  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const textLength = textNode.data.length;
    range.setStart(textNode, clamp(start, 0, textLength));
    range.setEnd(textNode, clamp(end, 0, textLength));
  } else {
    range.setStart(root, 0);
    range.setEnd(root, 0);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readState(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(RECORD_KEY);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function writeState(db, state) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(state, RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readLegacyState() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const chapter = createChapter(typeof parsed.text === 'string' ? parsed.text : '');
    return normalizeState({
      chapters: [chapter],
      currentChapterId: chapter.id,
      fontSize: parsed.fontSize,
      chapterViewStateById: {
        [chapter.id]: {
          selectionStart: Number(parsed.selectionStart) || 0,
          selectionEnd: Number(parsed.selectionEnd) || 0,
          scrollTop: Number(parsed.scrollTop) || 0,
        },
      },
    });
  } catch {
    return null;
  }
}

function App() {
  const editorRef = useRef(null);
  const savedRef = useRef(null);
  const statsRef = useRef(null);
  const stateRef = useRef(createEmptyState());
  const dbRef = useRef(null);
  const saveTimerRef = useRef(null);
  const writeChainRef = useRef(Promise.resolve());
  const readyRef = useRef(false);
  const mountedRef = useRef(false);
  const wordCountsRef = useRef({ currentChapter: 0, totalBook: 0 });
  const isPickerOpenRef = useRef(false);
  const deleteConfirmRef = useRef(null);

  const cloudSyncTimerRef = useRef(null);
  const isSyncingRef = useRef(false);
  const isSyncPendingRef = useRef(false);
  const isDeferredSyncUpdateRef = useRef(false);

  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    isPickerOpenRef.current = isPickerOpen;
  }, [isPickerOpen]);

  useEffect(() => {
    deleteConfirmRef.current = deleteConfirm;
  }, [deleteConfirm]);

  const updateSavedLabel = (label, totalWords = wordCountsRef.current.totalBook) => {
    if (savedRef.current) {
      savedRef.current.textContent = `${label} • ${totalWords.toLocaleString()} words`;
    }
  };

  const updateStatsPanel = () => {
    const stats = statsRef.current;
    if (!stats) {
      return;
    }

    const currentLine = stats.querySelector('[data-role="current-words"]');
    const totalLine = stats.querySelector('[data-role="total-words"]');

    if (currentLine) {
      currentLine.textContent = `${wordCountsRef.current.currentChapter.toLocaleString()} words`;
    }

    if (totalLine) {
      totalLine.textContent = `${wordCountsRef.current.totalBook.toLocaleString()} words`;
    }
  };

  const closeChapterPicker = () => {
    setIsPickerOpen(false);
    setDeleteConfirm(null);
  };

  const updateWordCounts = () => {
    const state = stateRef.current;
    const currentChapter = getCurrentChapter(state);
    const currentContent = currentChapter?.content ?? '';
    const totalBook = state.chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0);

    wordCountsRef.current = {
      currentChapter: countWords(currentContent),
      totalBook,
    };

    updateSavedLabel('Saved', totalBook);
    updateStatsPanel();
  };

  const openChapterPicker = () => {
    setIsPickerOpen(true);
    setDeleteConfirm(null);
  };

  const selectChapterFromPicker = (index) => {
    switchToChapter(index);
    closeChapterPicker();
  };

  const triggerExport = async () => {
    captureCurrentChapterState();
    const snapshot = normalizeState(JSON.parse(JSON.stringify(stateRef.current)));
    await exportBook(snapshot);
  };

  const triggerExportCurrentChapter = () => {
    captureCurrentChapterState();
    const snapshot = normalizeState(JSON.parse(JSON.stringify(stateRef.current)));
    exportCurrentChapter(snapshot);
  };

  const syncEditorHeight = () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  };

  const restorePageScroll = (scrollTop) => {
    window.requestAnimationFrame(() => {
      window.scrollTo(0, scrollTop);
    });
  };

  const normalizeEditorText = () => {
    const editor = editorRef.current;
    return (editor?.innerText ?? '').replace(/\r\n/g, '\n');
  };

  const captureCurrentChapterState = () => {
    const editor = editorRef.current;
    const state = stateRef.current;
    const chapter = getCurrentChapter(state);
    if (!editor || !chapter) {
      return;
    }

    const { selectionStart, selectionEnd } = getSelectionOffsets(editor);
    const content = normalizeEditorText();

    const prevContent = chapter.content;
    const prevViewState = state.chapterViewStateById[chapter.id];

    const contentChanged = prevContent !== content;
    const viewStateChanged =
      !prevViewState ||
      prevViewState.selectionStart !== selectionStart ||
      prevViewState.selectionEnd !== selectionEnd ||
      prevViewState.scrollTop !== window.scrollY;

    const chapterIndex = getCurrentChapterIndex(state);
    state.chapters[chapterIndex] = {
      ...chapter,
      content,
      updated_at: contentChanged ? Date.now() : (chapter.updated_at || Date.now()),
    };

    state.chapterViewStateById[chapter.id] = {
      selectionStart,
      selectionEnd,
      scrollTop: window.scrollY ?? 0,
    };

    if (contentChanged || viewStateChanged) {
      state.metadata_updated_at = Date.now();
    }

    updateWordCounts();
  };

  const syncWithCloud = async () => {
    if (!supabase || !readyRef.current) {
      return;
    }
    if (isSyncingRef.current) {
      isSyncPendingRef.current = true;
      return;
    }
    isSyncingRef.current = true;

    try {
      updateSavedLabel('Syncing...');

      const [chaptersRes, metadataRes] = await Promise.all([
        supabase.from('chapters').select('*'),
        supabase.from('book_metadata').select('*').eq('id', 'main').maybeSingle()
      ]);

      if (chaptersRes.error) throw chaptersRes.error;
      if (metadataRes.error) throw metadataRes.error;

      const remoteChapters = chaptersRes.data || [];
      const remoteMetadata = metadataRes.data || null;

      const localState = stateRef.current;
      let localUpdated = false;
      const chaptersToUpsert = [];
      const chaptersToDelete = [];

      let activeMetadata;
      let localMetadataWinning = false;

      if (!remoteMetadata) {
        localMetadataWinning = true;
        activeMetadata = {
          id: 'main',
          current_chapter_id: localState.currentChapterId,
          font_size: localState.fontSize,
          chapter_order: localState.chapters.map((c) => c.id),
          chapter_view_states: localState.chapterViewStateById,
          updated_at: new Date(localState.metadata_updated_at || Date.now()).toISOString(),
        };
      } else {
        const remoteUpdatedAt = new Date(remoteMetadata.updated_at).getTime();
        const localUpdatedAt = localState.metadata_updated_at || 0;

        if (localUpdatedAt > remoteUpdatedAt) {
          localMetadataWinning = true;
          activeMetadata = {
            id: 'main',
            current_chapter_id: localState.currentChapterId,
            font_size: localState.fontSize,
            chapter_order: localState.chapters.map((c) => c.id),
            chapter_view_states: localState.chapterViewStateById,
            updated_at: new Date(localState.metadata_updated_at).toISOString(),
          };
        } else if (remoteUpdatedAt > localUpdatedAt) {
          activeMetadata = remoteMetadata;
          // Keep the local active chapter to prevent disrupting the user's viewport
          localState.fontSize = remoteMetadata.font_size;
          localState.chapterViewStateById = remoteMetadata.chapter_view_states || {};
          localState.metadata_updated_at = remoteUpdatedAt;
          localUpdated = true;
        } else {
          activeMetadata = remoteMetadata;
        }
      }

      const activeChapterOrder = activeMetadata.chapter_order || [];
      const remoteChaptersMap = new Map(remoteChapters.map((c) => [c.id, c]));
      const localChaptersMap = new Map(localState.chapters.map((c) => [c.id, c]));
      const mergedChapters = [];

      for (const chapterId of activeChapterOrder) {
        const localCh = localChaptersMap.get(chapterId);
        const remoteCh = remoteChaptersMap.get(chapterId);

        if (localCh && remoteCh) {
          const localTime = localCh.updated_at || 0;
          const remoteTime = new Date(remoteCh.updated_at).getTime();

          if (localTime > remoteTime) {
            chaptersToUpsert.push({
              id: chapterId,
              content: localCh.content,
              updated_at: new Date(localTime).toISOString(),
            });
            mergedChapters.push(localCh);
          } else if (remoteTime > localTime) {
            if (localCh.content !== remoteCh.content) {
              const updatedCh = {
                id: chapterId,
                content: remoteCh.content,
                updated_at: remoteTime,
              };
              mergedChapters.push(updatedCh);
              localUpdated = true;
            } else {
              mergedChapters.push(localCh);
            }
          } else {
            mergedChapters.push(localCh);
          }
        } else if (localCh) {
          chaptersToUpsert.push({
            id: chapterId,
            content: localCh.content,
            updated_at: new Date(localCh.updated_at || Date.now()).toISOString(),
          });
          mergedChapters.push(localCh);
        } else if (remoteCh) {
          const newLocalCh = {
            id: chapterId,
            content: remoteCh.content,
            updated_at: new Date(remoteCh.updated_at).getTime(),
          };
          mergedChapters.push(newLocalCh);
          localUpdated = true;
        }
      }

      if (
        localUpdated ||
        mergedChapters.length !== localState.chapters.length ||
        mergedChapters.some(
          (c, i) =>
            c.id !== localState.chapters[i].id ||
            c.content !== localState.chapters[i].content
        )
      ) {
        localState.chapters = mergedChapters;
        localUpdated = true;
      }

      const activeChapterOrderSet = new Set(activeChapterOrder);
      for (const remoteCh of remoteChapters) {
        if (!activeChapterOrderSet.has(remoteCh.id)) {
          chaptersToDelete.push(remoteCh.id);
        }
      }

      const networkPromises = [];

      if (localMetadataWinning) {
        networkPromises.push(supabase.from('book_metadata').upsert(activeMetadata));
      }

      if (chaptersToUpsert.length > 0) {
        networkPromises.push(supabase.from('chapters').upsert(chaptersToUpsert));
      }

      if (chaptersToDelete.length > 0) {
        networkPromises.push(supabase.from('chapters').delete().in('id', chaptersToDelete));
      }

      if (networkPromises.length > 0) {
        const results = await Promise.all(networkPromises);
        const errorResult = results.find((r) => r.error);
        if (errorResult) throw errorResult.error;
      }

      if (localUpdated) {
        const normalized = normalizeState(localState);
        stateRef.current = normalized;
        await writeState(dbRef.current, normalized);

        const isEditing = document.activeElement === editorRef.current;
        const editor = editorRef.current;
        if (editor) {
          const activeCh = getCurrentChapter(normalized);
          const contentChanged = editor.textContent !== activeCh.content;
          const currentFontSize = parseFloat(editor.style.fontSize) || normalized.fontSize;
          const fontSizeChanged = currentFontSize !== normalized.fontSize;
          const indexChanged = getCurrentChapterIndex(normalized) !== currentChapterIndex;

          if (contentChanged || fontSizeChanged || indexChanged) {
            if (!isEditing) {
              setCurrentChapterIndex(getCurrentChapterIndex(normalized));
              renderCurrentChapter();
            } else {
              isDeferredSyncUpdateRef.current = true;
              editor.style.fontSize = `${normalized.fontSize}px`;
              syncEditorHeight();
            }
          }
        }
      }

      updateSavedLabel('Synced');
      isSyncPendingRef.current = false;
    } catch (err) {
      console.error('Cloud sync failed:', err);
      updateSavedLabel('Sync offline');
      isSyncPendingRef.current = true;
    } finally {
      isSyncingRef.current = false;
    }
  };

  const scheduleCloudSync = () => {
    if (!supabase) {
      return;
    }
    window.clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = window.setTimeout(() => {
      syncWithCloud();
    }, 2000);
  };

  const enqueuePersist = (snapshot) => {
    const db = dbRef.current;
    if (!db) {
      return;
    }

    updateSavedLabel('Saving...');
    writeChainRef.current = writeChainRef.current.then(() => writeState(db, snapshot)).catch(() => writeState(db, snapshot));
    writeChainRef.current
      .then(() => {
        updateSavedLabel('Saved');
      })
      .catch(() => {
        updateSavedLabel('Saved');
      });
  };

  const persistNow = () => {
    captureCurrentChapterState();
    const snapshot = normalizeState(JSON.parse(JSON.stringify(stateRef.current)));
    enqueuePersist(snapshot);
    scheduleCloudSync();
  };

  const schedulePersist = () => {
    if (!readyRef.current) {
      return;
    }

    window.clearTimeout(saveTimerRef.current);
    updateSavedLabel('Saving...');
    saveTimerRef.current = window.setTimeout(() => {
      persistNow();
    }, SAVE_DELAY_MS);
  };

  const renderCurrentChapter = () => {
    const editor = editorRef.current;
    const state = stateRef.current;
    const chapter = getCurrentChapter(state);
    if (!editor || !chapter) {
      return;
    }

    const viewState = state.chapterViewStateById[chapter.id] ?? {
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
    };

    editor.textContent = chapter.content;
    editor.style.fontSize = `${state.fontSize}px`;
    syncEditorHeight();
    updateWordCounts();

    editor.focus({ preventScroll: true });
    setSelectionOffsets(editor, viewState.selectionStart, viewState.selectionEnd);
    restorePageScroll(viewState.scrollTop);
  };

  const switchToChapter = (nextIndex) => {
    const state = stateRef.current;
    if (nextIndex < 0 || nextIndex >= state.chapters.length) {
      return;
    }

    captureCurrentChapterState();
    state.currentChapterId = state.chapters[nextIndex].id;
    setCurrentChapterIndex(nextIndex);
    renderCurrentChapter();
    persistNow();
  };

  const createChapterAfterCurrent = () => {
    captureCurrentChapterState();

    const state = stateRef.current;
    const currentIndex = getCurrentChapterIndex(state);
    const nextChapter = createChapter('');
    state.chapters.splice(currentIndex + 1, 0, nextChapter);
    state.chapterViewStateById[nextChapter.id] = {
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
    };
    state.currentChapterId = nextChapter.id;

    setCurrentChapterIndex(currentIndex + 1);
    renderCurrentChapter();
    persistNow();
  };

  const prepareDeleteCurrentChapter = () => {
    captureCurrentChapterState();

    const state = stateRef.current;
    if (state.chapters.length === 1) {
      return;
    }

    const currentIndex = getCurrentChapterIndex(state);
    const chapter = state.chapters[currentIndex];
    setDeleteConfirm({
      chapterId: chapter.id,
      chapterNumber: currentIndex + 1,
      wordCount: countWords(chapter.content),
    });
  };

  const deleteCurrentChapter = () => {
    const state = stateRef.current;
    if (state.chapters.length === 1) {
      return;
    }

    const currentIndex = getCurrentChapterIndex(state);
    const confirmedChapterId = deleteConfirmRef.current?.chapterId;
    const deleteIndex = confirmedChapterId && state.chapters.some((chapter) => chapter.id === confirmedChapterId)
      ? state.chapters.findIndex((chapter) => chapter.id === confirmedChapterId)
      : currentIndex;

    if (deleteIndex < 0 || state.chapters.length === 1) {
      return;
    }

    const [removedChapter] = state.chapters.splice(deleteIndex, 1);
    if (removedChapter) {
      delete state.chapterViewStateById[removedChapter.id];
    }

    const nextIndex = deleteIndex > 0 ? deleteIndex - 1 : 0;
    state.currentChapterId = state.chapters[nextIndex].id;
    setCurrentChapterIndex(nextIndex);
    setDeleteConfirm(null);
    setIsPickerOpen(false);
    renderCurrentChapter();
    persistNow();
  };

  const applyFontSize = (nextSize) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const { selectionStart, selectionEnd } = getSelectionOffsets(editor);
    const scrollTop = window.scrollY ?? 0;
    stateRef.current.fontSize = clamp(nextSize, MIN_FONT_SIZE, MAX_FONT_SIZE);
    editor.style.fontSize = `${stateRef.current.fontSize}px`;
    syncEditorHeight();
    persistNow();
    restorePageScroll(scrollTop);
    setSelectionOffsets(editor, selectionStart ?? 0, selectionEnd ?? selectionStart ?? 0);
  };

  const adjustFontSize = (delta) => {
    applyFontSize(stateRef.current.fontSize + delta);
  };

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    // Set page title dynamically depending on cloud sync presence
    document.title = supabase ? 'Still Here' : 'Ink Writer';

    const init = async () => {
      try {
        const db = await openDatabase();
        if (cancelled) {
          db.close();
          return;
        }

        dbRef.current = db;

        let stored = await readState(db);
        let fromCloud = false;

        // If local IndexedDB is empty, check remote cloud before initializing a new empty book
        if (!stored && supabase) {
          try {
            updateSavedLabel('Syncing...');
            const [chaptersRes, metadataRes] = await Promise.all([
              supabase.from('chapters').select('*'),
              supabase.from('book_metadata').select('*').eq('id', 'main').maybeSingle()
            ]);

            if (!chaptersRes.error && !metadataRes.error && metadataRes.data) {
              const remoteChapters = chaptersRes.data || [];
              const remoteMetadata = metadataRes.data;

              // Reconstruct the stored book shape from remote tables
              const chapterOrder = remoteMetadata.chapter_order || [];
              const remoteChaptersMap = new Map(remoteChapters.map((c) => [c.id, c]));
              const chapters = [];

              for (const chId of chapterOrder) {
                const remoteCh = remoteChaptersMap.get(chId);
                if (remoteCh) {
                  chapters.push({
                    id: chId,
                    content: remoteCh.content,
                    updated_at: new Date(remoteCh.updated_at).getTime(),
                  });
                }
              }

              if (chapters.length > 0) {
                stored = {
                  chapters,
                  currentChapterId: remoteMetadata.current_chapter_id,
                  fontSize: remoteMetadata.font_size,
                  chapterViewStateById: remoteMetadata.chapter_view_states || {},
                  metadata_updated_at: new Date(remoteMetadata.updated_at).getTime(),
                };
                fromCloud = true;
              }
            }
          } catch (cloudErr) {
            console.error('Failed to query cloud data during initialization:', cloudErr);
          }
        }

        if (!stored) {
          stored = readLegacyState() ?? createEmptyState();
          await writeState(db, stored);
        } else if (fromCloud) {
          await writeState(db, stored);
        }

        const normalized = normalizeState(stored);
        stateRef.current = normalized;
        readyRef.current = true;
        setCurrentChapterIndex(getCurrentChapterIndex(normalized));
        renderCurrentChapter();

        if (supabase) {
          syncWithCloud();
          intervalId = window.setInterval(() => {
            syncWithCloud();
          }, 30000);
        }
      } catch {
        if (cancelled) {
          return;
        }

        const fallback = readLegacyState() ?? createEmptyState();
        stateRef.current = fallback;
        readyRef.current = true;
        setCurrentChapterIndex(getCurrentChapterIndex(fallback));
        renderCurrentChapter();

        if (supabase) {
          syncWithCloud();
          intervalId = window.setInterval(() => {
            syncWithCloud();
          }, 30000);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      window.clearTimeout(saveTimerRef.current);
      dbRef.current?.close?.();
      if (intervalId) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return undefined;
    }

    const handleInput = () => {
      if (!mountedRef.current) {
        return;
      }

      const state = stateRef.current;
      const chapter = getCurrentChapter(state);
      if (!chapter) {
        return;
      }

      const newContent = normalizeEditorText();
      const contentChanged = chapter.content !== newContent;

      const chapterIndex = getCurrentChapterIndex(state);
      state.chapters[chapterIndex] = {
        ...chapter,
        content: newContent,
        updated_at: contentChanged ? Date.now() : (chapter.updated_at || Date.now()),
      };

      const { selectionStart, selectionEnd } = getSelectionOffsets(editor);
      const prevViewState = state.chapterViewStateById[chapter.id];
      const viewStateChanged =
        !prevViewState ||
        prevViewState.selectionStart !== selectionStart ||
        prevViewState.selectionEnd !== selectionEnd ||
        prevViewState.scrollTop !== window.scrollY;

      state.chapterViewStateById[chapter.id] = {
        selectionStart,
        selectionEnd,
        scrollTop: window.scrollY ?? 0,
      };

      if (contentChanged || viewStateChanged) {
        state.metadata_updated_at = Date.now();
      }

      syncEditorHeight();
      updateWordCounts();
      schedulePersist();
    };

    const handleSelectionChange = () => {
      if (!mountedRef.current) {
        return;
      }

      schedulePersist();
    };

    const handlePageScroll = () => {
      if (!mountedRef.current) {
        return;
      }

      schedulePersist();
    };

    const handleResize = () => {
      if (!mountedRef.current) {
        return;
      }

      syncEditorHeight();
    };

    const handleKeyDown = (event) => {
      if (!mountedRef.current) {
        return;
      }

      if (!event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        createChapterAfterCurrent();
        return;
      }

      if (key === 'k') {
        event.preventDefault();
        switchToChapter(getCurrentChapterIndex(stateRef.current) - 1);
        return;
      }

      if (key === 'l') {
        event.preventDefault();
        switchToChapter(getCurrentChapterIndex(stateRef.current) + 1);
        return;
      }

      if (key === 'c') {
        event.preventDefault();
        setIsStatsOpen((value) => !value);
        return;
      }

      if (key === 'e') {
        event.preventDefault();
        triggerExport();
        return;
      }

      if (key === 'x') {
        event.preventDefault();
        triggerExportCurrentChapter();
        return;
      }

      if (key === '+' || key === '=' || key === '-' || key === '_') {
        event.preventDefault();
        adjustFontSize(key === '+' || key === '=' ? 1 : -1);
      }
    };

    const handlePageHide = () => {
      if (!mountedRef.current) {
        return;
      }

      persistNow();
    };

    const handleVisibilityChange = () => {
      if (!mountedRef.current) {
        return;
      }
      if (document.visibilityState === 'hidden') {
        persistNow();
      } else if (document.visibilityState === 'visible') {
        syncWithCloud();
      }
    };

    const handleGlobalKeyDown = (event) => {
      if (!mountedRef.current) {
        return;
      }

      if (event.key === 'Escape') {
        if (deleteConfirmRef.current) {
          setDeleteConfirm(null);
          return;
        }

        if (isPickerOpenRef.current) {
          setIsPickerOpen(false);
          return;
        }

        setIsStatsOpen(false);
      }
    };

    const handleOnline = () => {
      if (isSyncPendingRef.current) {
        syncWithCloud();
      }
    };

    const handleBlur = () => {
      if (isDeferredSyncUpdateRef.current) {
        isDeferredSyncUpdateRef.current = false;
        const normalized = normalizeState(stateRef.current);
        setCurrentChapterIndex(getCurrentChapterIndex(normalized));
        renderCurrentChapter();
      }
    };

    const handleWindowFocus = () => {
      if (mountedRef.current) {
        syncWithCloud();
      }
    };

    editor.addEventListener('input', handleInput);
    editor.addEventListener('keyup', handleSelectionChange);
    editor.addEventListener('mouseup', handleSelectionChange);
    editor.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handlePageScroll, { passive: true });
    window.addEventListener('resize', handleResize);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('online', handleOnline);
    editor.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleWindowFocus);

    mountedRef.current = true;

    return () => {
      window.clearTimeout(saveTimerRef.current);
      editor.removeEventListener('input', handleInput);
      editor.removeEventListener('keyup', handleSelectionChange);
      editor.removeEventListener('mouseup', handleSelectionChange);
      editor.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handlePageScroll);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('online', handleOnline);
      editor.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  return (
    <main className="app-shell">
      <div className="chrome">
        <button
          type="button"
          className="chapter-label chapter-label-button"
          onClick={openChapterPicker}
          aria-haspopup="dialog"
          aria-expanded={isPickerOpen}
        >
          {`CHAPTER ${currentChapterIndex + 1}`}
        </button>
        <div className="controls" aria-label="Font size controls">
          <button type="button" onClick={() => adjustFontSize(-1)} aria-label="Decrease font size">
            −
          </button>
          <button type="button" onClick={() => adjustFontSize(1)} aria-label="Increase font size">
            +
          </button>
          <button type="button" className="export-button" onClick={triggerExport} aria-label="Export book">
            Export
          </button>
        </div>
      </div>

      <div
        ref={editorRef}
        className="editor"
        contentEditable="plaintext-only"
        suppressContentEditableWarning={true}
        spellCheck="true"
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect="on"
        role="textbox"
        aria-multiline="true"
        aria-label="Chapter editor"
      />

      <div ref={savedRef} className="save-indicator" aria-live="polite">
        Saved • {wordCountsRef.current.totalBook.toLocaleString()} words
      </div>

      {isPickerOpen ? (
        <div className="chapter-modal-backdrop" role="presentation" onClick={closeChapterPicker}>
          <div
            className="chapter-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Chapter picker"
            onClick={(event) => event.stopPropagation()}
          >
            <ol className="chapter-modal-list">
              {stateRef.current.chapters.map((chapter, index) => (
                <li key={chapter.id}>
                  <button
                    type="button"
                    className={`chapter-modal-item${index === currentChapterIndex ? ' is-current' : ''}`}
                    onClick={() => selectChapterFromPicker(index)}
                    aria-current={index === currentChapterIndex ? 'true' : undefined}
                  >
                    {formatChapterNumber(index)}
                  </button>
                </li>
              ))}
            </ol>

            <div className="chapter-modal-actions">
              <button
                type="button"
                className="chapter-modal-action"
                onClick={() => {
                  createChapterAfterCurrent();
                  closeChapterPicker();
                }}
              >
                + New Chapter
              </button>
              <button
                type="button"
                className="chapter-modal-action"
                onClick={prepareDeleteCurrentChapter}
                disabled={stateRef.current.chapters.length === 1}
              >
                Delete Current Chapter
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteConfirm ? (
        <div className="chapter-modal-backdrop" role="presentation" onClick={() => setDeleteConfirm(null)}>
          <div
            className="delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Delete chapter confirmation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="delete-confirm-title">{`Delete Chapter ${deleteConfirm.chapterNumber}?`}</div>
            <div className="delete-confirm-body">{`This chapter contains ${deleteConfirm.wordCount.toLocaleString()} words.`}</div>
            <div className="delete-confirm-body">This action cannot be undone.</div>
            <div className="delete-confirm-actions">
              <button type="button" className="chapter-modal-action" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="chapter-modal-action danger" onClick={deleteCurrentChapter}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isStatsOpen ? (
        <div ref={statsRef} className="stats-overlay" role="dialog" aria-label="Word counts">
          <div>Current chapter words</div>
          <div data-role="current-words">{`${wordCountsRef.current.currentChapter.toLocaleString()} words`}</div>
          <div>Total book words</div>
          <div data-role="total-words">{`${wordCountsRef.current.totalBook.toLocaleString()} words`}</div>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
