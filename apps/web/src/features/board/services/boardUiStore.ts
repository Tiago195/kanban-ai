import { create } from "zustand";

export type AppTabId =
  | "board"
  | "epics"
  | "stories"
  | "tasks"
  | "labels"
  | "assignees"
  | "ai-engine";

interface ModalStack {
  epicId: string | null;
  storyId: string | null;
  taskId: string | null;
}

interface BoardUiState {
  activeTab: AppTabId;
  draggedCardId: string | null;
  modals: ModalStack;
  setActiveTab: (tab: AppTabId) => void;
  setDraggedCard: (cardId: string | null) => void;
  openEpic: (epicId: string) => void;
  openStory: (storyId: string, epicId?: string | null) => void;
  openTask: (taskId: string) => void;
  closeTopModal: () => void;
  closeEpic: () => void;
  closeStory: () => void;
  closeTask: () => void;
  closeAllModals: () => void;
}

const initialModals: ModalStack = { epicId: null, storyId: null, taskId: null };

export const useBoardUiStore = create<BoardUiState>((set) => ({
  activeTab: "board",
  draggedCardId: null,
  modals: initialModals,

  setActiveTab: (activeTab) => set({ activeTab }),
  setDraggedCard: (draggedCardId) => set({ draggedCardId }),

  openEpic: (epicId) =>
    set(() => ({
      modals: { epicId, storyId: null, taskId: null },
    })),

  openStory: (storyId, epicId = null) =>
    set((state) => ({
      modals: {
        epicId: epicId ?? state.modals.epicId,
        storyId,
        taskId: null,
      },
    })),

  openTask: (taskId) =>
    set((state) => ({
      modals: {
        epicId: state.modals.epicId,
        storyId: state.modals.storyId,
        taskId,
      },
    })),

  closeTopModal: () =>
    set((state) => {
      if (state.modals.taskId) {
        return { modals: { ...state.modals, taskId: null } };
      }
      if (state.modals.storyId) {
        return { modals: { ...state.modals, storyId: null, taskId: null } };
      }
      if (state.modals.epicId) {
        return { modals: initialModals };
      }
      return state;
    }),

  closeEpic: () => set({ modals: initialModals }),
  closeStory: () => set((state) => ({ modals: { ...state.modals, storyId: null, taskId: null } })),
  closeTask: () => set((state) => ({ modals: { ...state.modals, taskId: null } })),
  closeAllModals: () => set({ modals: initialModals }),
}));
