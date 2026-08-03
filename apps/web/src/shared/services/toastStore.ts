import { create } from "zustand";

interface ToastState {
  message: string | null;
  showToast: (message: string) => void;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  showToast: (message) => {
    set({ message });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ message: null }), 2500);
  },
  clear: () => set({ message: null }),
}));

export const showToast = (message: string) => useToastStore.getState().showToast(message);
