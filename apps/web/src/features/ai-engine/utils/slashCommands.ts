import type { ChatPanelSlashCommand } from "@/features/ai-engine/components/ChatPanel";

export function getSlashQuery(input: string): string | null {
  const normalized = input.trimStart();
  if (!normalized.startsWith("/")) return null;
  return normalized;
}

export function parseSlashCommand(
  input: string,
  commands: ChatPanelSlashCommand[],
): ChatPanelSlashCommand | null {
  const normalized = getSlashQuery(input);
  if (!normalized) return null;
  const cmd = normalized.split(/\s+/)[0]?.toLowerCase();
  return commands.find((command) => command.cmd.toLowerCase() === cmd) ?? null;
}

export function filterSlashCommands(
  input: string,
  commands: ChatPanelSlashCommand[],
): ChatPanelSlashCommand[] {
  const normalized = getSlashQuery(input);
  if (!normalized) return [];

  const [token] = normalized.split(/\s+/);
  const prefix = token.toLowerCase();

  return commands.filter((command) => command.cmd.toLowerCase().startsWith(prefix));
}
