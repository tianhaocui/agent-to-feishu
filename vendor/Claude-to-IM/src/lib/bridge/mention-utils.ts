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

/**
 * Pre-compiled mention matcher for hot-path usage (streaming callbacks).
 * Builds a single combined regex from the bot set instead of creating
 * one regex per bot per paragraph on every call.
 */
export class MentionMatcher {
  private combinedRe: RegExp | null;
  private botSet: Set<string>;

  constructor(knownBots: Set<string>) {
    this.botSet = knownBots;
    if (knownBots.size === 0) {
      this.combinedRe = null;
    } else {
      const alternatives = [...knownBots].map(escapeRegex).join('|');
      this.combinedRe = new RegExp(`^@(?:\\[(${alternatives})\\]|(${alternatives})(?![\\w]))`);
    }
  }

  split(text: string): MentionSegment[] {
    if (!this.combinedRe) return [{ targetBot: null, text }];
    const paragraphs = text.split(/\n\n+/);
    const segments: MentionSegment[] = [];
    let current: MentionSegment = { targetBot: null, text: '' };
    for (const para of paragraphs) {
      const m = para.match(this.combinedRe);
      const mentionedBot = m ? (m[1] || m[2]) : null;
      if (mentionedBot && this.botSet.has(mentionedBot)) {
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
}
