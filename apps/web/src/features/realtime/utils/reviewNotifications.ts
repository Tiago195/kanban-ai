import type { ServerEvent } from "@kanban-ai/shared";

export const REVIEW_NOTIFICATION_PREF_KEY = "kanban-ai-review-notifications-enabled";
export const TAB_FOCUS_HEARTBEAT_KEY = "kanban-ai-tab-focus";

export interface ShouldNotifyInput {
  permission: NotificationPermission | "unsupported";
  thisTabFocused: boolean;
  otherTabFocusedRecently: boolean;
  prefEnabled: boolean;
}

export function shouldNotify({
  permission,
  thisTabFocused,
  otherTabFocusedRecently,
  prefEnabled,
}: ShouldNotifyInput): boolean {
  if (!prefEnabled) return false;
  if (permission !== "granted") return false;
  if (thisTabFocused) return false;
  if (otherTabFocusedRecently) return false;
  return true;
}

export function isHumanAttentionEvent(event: ServerEvent): event is Extract<ServerEvent, { type: "card.needs_human" | "review.comment_added" }> {
  return event.type === "card.needs_human" || event.type === "review.comment_added";
}

export function getTaskIdFromEvent(event: Extract<ServerEvent, { type: "card.needs_human" | "review.comment_added" }>): string {
  if (event.type === "card.needs_human") return event.taskId;
  return event.cardId;
}
