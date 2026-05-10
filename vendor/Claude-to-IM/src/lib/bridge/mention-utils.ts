/**
 * Shared utility for splitting text by @mention segments.
 * Used by both bridge-manager (streaming detection) and feishu-adapter (onStreamEnd).
 */

export interface MentionSegment {
  targetBot: string | null;
  text: string;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitByMentions(text: string, knownBots: Set<string>): MentionSegment[] {
  const paragraphs = text.split(/\n\n+/);
  const segments: MentionSegment[] = [];
  let current: MentionSegment = { targetBot: null, text: '' };
  for (const para of paragraphs) {
    const bracketMatch = para.match(/^@\[([^\]]+)\]/);
    let mentionedBot = bracketMatch?.[1] || null;
    if (!mentionedBot) {
      for (const name of knownBots) {
        const re = new RegExp(`^@${escapeRegex(name)}(?![\\w])`);
        if (re.test(para)) { mentionedBot = name; break; }
      }
    }
    if (mentionedBot && knownBots.has(mentionedBot)) {
      if (current.text.trim()) segments.push(current);
      current = { targetBot: mentionedBot, text: para };
    } else if (current.targetBot !== null) {
      segments.push(current);
      current = { targetBot: null, text: para };
    } else {
      current.text += (current.text ? '\n\n' : '') + para;
    }
  }
  if (current.text.trim()) segments.push(current);
  return segments;
}
