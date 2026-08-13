import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@kanban-ai/shared";

import {
  getTaskIdFromEvent,
  isHumanAttentionEvent,
  REVIEW_NOTIFICATION_PREF_KEY,
  shouldNotify,
  TAB_FOCUS_HEARTBEAT_KEY,
} from "@/features/realtime/utils/reviewNotifications";

const HEARTBEAT_FRESH_MS = 4000;

function getPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function isThisTabFocused(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function readPrefEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(REVIEW_NOTIFICATION_PREF_KEY) === "true";
}

function writeHeartbeat(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TAB_FOCUS_HEARTBEAT_KEY, String(Date.now()));
}

function otherTabFocusedRecently(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(TAB_FOCUS_HEARTBEAT_KEY);
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < HEARTBEAT_FRESH_MS;
}

export function useReviewNotifications(lastEvent: ServerEvent | null) {
  const [pendingCount, setPendingCount] = useState(0);
  const [prefEnabled, setPrefEnabled] = useState<boolean>(() => readPrefEnabled());
  const baseTitleRef = useRef<string>(typeof document !== "undefined" ? document.title : "");
  const mountedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const onFocusLike = () => {
      if (!isThisTabFocused()) return;
      writeHeartbeat();
      setPendingCount(0);
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === REVIEW_NOTIFICATION_PREF_KEY) {
        setPrefEnabled(event.newValue === "true");
      }
    };

    if (isThisTabFocused()) writeHeartbeat();

    window.addEventListener("focus", onFocusLike);
    document.addEventListener("visibilitychange", onFocusLike);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("focus", onFocusLike);
      document.removeEventListener("visibilitychange", onFocusLike);
      window.removeEventListener("storage", onStorage);
      document.title = baseTitleRef.current;
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    document.title = pendingCount > 0 ? `(${pendingCount}) ${baseTitleRef.current}` : baseTitleRef.current;
  }, [pendingCount]);

  useEffect(() => {
    if (!lastEvent || !isHumanAttentionEvent(lastEvent)) return;

    setPendingCount((prev) => prev + 1);

    const thisFocused = isThisTabFocused();
    const canNotify = shouldNotify({
      permission: getPermission(),
      thisTabFocused: thisFocused,
      otherTabFocusedRecently: !thisFocused && otherTabFocusedRecently(),
      prefEnabled,
    });

    if (!canNotify) return;

    const taskId = getTaskIdFromEvent(lastEvent);
    const title = lastEvent.type === "card.needs_human" ? "Task precisa de revisão humana" : "Novo comentário de review";
    const body = lastEvent.type === "card.needs_human" ? lastEvent.reason : "Há nova atividade de review em uma task.";
    new Notification(title, {
      body,
      tag: taskId,
    });
  }, [lastEvent, prefEnabled]);

  const setNotificationsEnabled = async (enabled: boolean) => {
    if (typeof window === "undefined") return false;

    if (!enabled) {
      window.localStorage.setItem(REVIEW_NOTIFICATION_PREF_KEY, "false");
      setPrefEnabled(false);
      return true;
    }

    if (!("Notification" in window)) return false;

    const permission = await Notification.requestPermission();
    const allowed = permission === "granted";
    window.localStorage.setItem(REVIEW_NOTIFICATION_PREF_KEY, allowed ? "true" : "false");
    setPrefEnabled(allowed);
    return allowed;
  };

  return {
    pendingCount,
    prefEnabled,
    setNotificationsEnabled,
  };
}
