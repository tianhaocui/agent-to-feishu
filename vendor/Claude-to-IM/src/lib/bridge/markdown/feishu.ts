import type { ToolCallInfo } from '../types.js';

/**
 * Feishu-specific Markdown processing.
 *
 * Aligned with openclaw-lark (larksuite/openclaw-lark) patterns:
 * - splitReasoningText / stripReasoningTags for thinking content
 * - optimizeMarkdownStyle for Feishu rendering
 * - Collapsible panels for reasoning in final cards
 * - i18n support (zh_cn / en_us)
 * - Card summary for feed preview
 * - sanitizeTextSegmentsForCard for table limit compliance
 */

// ── Reasoning text utilities ─────────────────────────────────

const REASONING_PREFIX = 'Reasoning:\n';

/**
 * Split a payload text into optional reasoningText and answerText.
 * Handles two formats:
 * 1. "Reasoning:\n_italic line_\n…" prefix
 * 2. <think>/<thinking>/<thought> XML tags
 */
export function splitReasoningText(text?: string): {
  reasoningText?: string;
  answerText?: string;
} {
  if (typeof text !== 'string' || !text.trim()) return {};

  const trimmed = text.trim();

  // Case 1: "Reasoning:\n..." prefix
  if (trimmed.startsWith(REASONING_PREFIX) && trimmed.length > REASONING_PREFIX.length) {
    return { reasoningText: cleanReasoningPrefix(trimmed) };
  }

  // Case 2: XML thinking tags
  const taggedReasoning = extractThinkingContent(text);
  const strippedAnswer = stripReasoningTags(text);
  if (!taggedReasoning && strippedAnswer === text) {
    return { answerText: text };
  }
  return {
    reasoningText: taggedReasoning || undefined,
    answerText: strippedAnswer || undefined,
  };
}

/** Extract content from <think>, <thinking>, <thought> blocks. */
function extractThinkingContent(text: string): string {
  if (!text) return '';
  const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
  let result = '';
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(scanRe)) {
    const idx = match.index ?? 0;
    if (inThinking) {
      result += text.slice(lastIndex, idx);
    }
    inThinking = match[1] !== '/';
    lastIndex = idx + match[0].length;
  }
  // Handle unclosed tag (still streaming)
  if (inThinking) {
    result += text.slice(lastIndex);
  }
  return result.trim();
}

/**
 * Strip reasoning blocks — both XML tags with content and "Reasoning:\n" prefix.
 */
export function stripReasoningTags(text: string): string {
  // Strip complete XML blocks
  let result = text.replace(
    /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi,
    '',
  );
  // Strip unclosed tag at end (streaming)
  result = result.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*$/gi, '');
  // Strip orphaned closing tags
  result = result.replace(/<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, '');
  return result.trim();
}

/** Clean "Reasoning:\n_italic_" formatted message back to plain text. */
function cleanReasoningPrefix(text: string): string {
  let cleaned = text.replace(/^Reasoning:\s*/i, '');
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/^_(.+)_$/, '$1'))
    .join('\n');
  return cleaned.trim();
}

/** Format reasoning duration into i18n pair. */
export function formatReasoningDuration(ms: number): { zh: string; en: string } {
  const d = formatElapsed(ms);
  return { zh: `思考了 ${d}`, en: `Thought for ${d}` };
}

// ── Markdown utilities ───────────────────────────────────────

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Ensures code fences have a newline before them.
 */
export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Optimize markdown style for Feishu card rendering.
 * Aligned with openclaw-lark's optimizeMarkdownStyle().
 */
export function optimizeMarkdownStyle(text: string): string {
  if (!text) return text;
  let result = text;
  // Ensure code fences have newlines
  result = result.replace(/([^\n])```/g, '$1\n```');
  // Ensure list items have proper spacing
  result = result.replace(/([^\n])\n([-*+] )/g, '$1\n\n$2');
  result = result.replace(/([^\n])\n(\d+\. )/g, '$1\n\n$2');
  return result;
}

// ── Card builders ────────────────────────────────────────────

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Includes summary for feed preview.
 */
export function buildCardContent(text: string): string {
  const summaryText = text.replace(/[*_`#>[\]()~]/g, '').trim();
  const summary = summaryText ? { content: summaryText.slice(0, 120) } : undefined;

  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      ...(summary ? { summary } : {}),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: optimizeMarkdownStyle(text),
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content with i18n support.
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML to markdown for Feishu.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Tool progress ────────────────────────────────────────────

/**
 * Build tool progress markdown lines.
 * Shows elapsed time for running tools so users know the AI is still working.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const now = Date.now();
  const running = tools.filter(tc => tc.status === 'running');
  const done = tools.filter(tc => tc.status === 'complete');
  const failed = tools.filter(tc => tc.status !== 'running' && tc.status !== 'complete');
  const lines: string[] = [];
  for (const tc of running) {
    const elapsed = tc.startedAt ? formatElapsedRound(now - tc.startedAt) : '';
    lines.push(elapsed ? `🔄 \`${tc.name}\` (${elapsed})` : `🔄 \`${tc.name}\``);
  }
  for (const tc of failed) lines.push(`❌ \`${tc.name}\``);
  if (done.length > 0) lines.push(`✅ ${done.length} tool${done.length > 1 ? 's' : ''} done`);
  return lines.join('\n');
}

/** Format elapsed time as rounded integers (no decimals). */
function formatElapsedRound(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

// ── Streaming card content ───────────────────────────────────

/**
 * Build the body content for a streaming card update.
 * Combines main text with tool progress.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[]): string {
  let content = stripReasoningTags(text) || '';

  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }
  return content || '💭 Thinking...';
}

// ── Final card builder ───────────────────────────────────────

interface FinalCardFooter {
  status: string;
  elapsed: string;
  reasoningText?: string;
  reasoningElapsedMs?: number;
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | null;
  model?: string;
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress,
 * collapsible reasoning panel, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: FinalCardFooter | null,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Collapsible reasoning panel (before main content)
  if (footer?.reasoningText) {
    const dur = footer.reasoningElapsedMs
      ? formatReasoningDuration(footer.reasoningElapsedMs)
      : null;
    const zhLabel = dur ? dur.zh : '思考';
    const enLabel = dur ? dur.en : 'Thought';
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `💭 ${enLabel}`,
          i18n_content: {
            zh_cn: `💭 ${zhLabel}`,
            en_us: `💭 ${enLabel}`,
          },
        },
        vertical_align: 'center',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: footer.reasoningText,
          text_size: 'notation',
        },
      ],
    });
  }

  // Main text content
  let content = optimizeMarkdownStyle(preprocessFeishuMarkdown(text));
  const toolMd = buildToolProgressMarkdown(tools);
  if (toolMd) {
    content = content ? `${content}\n\n${toolMd}` : toolMd;
  }

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
    });
  }

  // Footer
  if (footer) {
    const statusLabels: Record<string, { zh: string; en: string }> = {
      completed: { zh: '已完成', en: 'Completed' },
      interrupted: { zh: '已停止', en: 'Stopped' },
      error: { zh: '出错', en: 'Error' },
    };
    const label = statusLabels[footer.status] || { zh: footer.status, en: footer.status };
    const zhParts = [label.zh];
    const enParts = [label.en];
    if (footer.elapsed) {
      zhParts.push(`耗时 ${footer.elapsed}`);
      enParts.push(`Elapsed ${footer.elapsed}`);
    }
    if (footer.tokenUsage) {
      const { input, output, cacheRead } = footer.tokenUsage;
      const tokenStr = cacheRead
        ? `${input}/${output} (cache ${cacheRead})`
        : `${input}/${output}`;
      zhParts.push(`tokens ${tokenStr}`);
      enParts.push(`tokens ${tokenStr}`);
    }
    if (footer.model) {
      zhParts.push(footer.model);
      enParts.push(footer.model);
    }

    const isError = footer.status === 'error';
    const zhText = zhParts.join(' · ');
    const enText = enParts.join(' · ');
    const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText;
    const enContent = isError ? `<font color='red'>${enText}</font>` : enText;

    elements.push({
      tag: 'markdown',
      content: enContent,
      i18n_content: { zh_cn: zhContent, en_us: enContent },
      text_size: 'notation',
    });
  }

  // Summary for feed preview
  const summaryText = text.replace(/[*_`#>[\]()~]/g, '').trim();
  const summary = summaryText ? { content: summaryText.slice(0, 120) } : undefined;

  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      locales: ['zh_cn', 'en_us'],
      ...(summary ? { summary } : {}),
    },
    body: { elements },
  });
}

// ── Permission card ──────────────────────────────────────────

/**
 * Build a permission card with real action buttons (column_set layout).
 */
/**
 * Build a pairing approval card with Approve/Reject buttons.
 * Sent to admin chat when an unapproved user requests access.
 */
export function buildPairingApprovalCard(
  userId: string,
  pairingCode: string,
  messagePreview: string,
  chatId?: string,
): string {
  const buttons = [
    { label: '✅ 批准 Approve', type: 'primary', action: 'approve' },
    { label: '❌ 拒绝 Reject', type: 'danger', action: 'reject' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `pairing:${btn.action}:${pairingCode}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  const preview = messagePreview
    ? messagePreview.replace(/[*_`#>[\]()~]/g, '').slice(0, 150)
    : '(无预览)';

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: '配对审批 Pairing Approval',
      },
      template: 'orange',
      icon: { tag: 'standard_icon', token: 'people-add_filled' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**用户 User:** \`${userId}\``, text_size: 'normal' },
        { tag: 'markdown', content: `**配对码 Code:** \`${pairingCode}\``, text_size: 'normal' },
        { tag: 'markdown', content: `**消息预览 Preview:** ${preview}`, text_size: 'normal' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
      ],
    },
  });
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}

// ── Resume session picker card ───────────────────────────

export interface ResumeSessionOption {
  bindingId: string;
  sessionIdShort: string;
  cwd: string;
  mode: string;
  active: boolean;
  runtime: string;
  updatedAt: string;
  lastMessage?: string;
}

/**
 * Build a CardKit v2 card with buttons for picking a session to resume.
 */
export function buildResumeSessionCard(
  chatId: string,
  sessions: ResumeSessionOption[],
): string {
  const elements: unknown[] = [];

  for (const s of sessions) {
    const status = s.active ? '🟢' : '⚪';
    const rt = s.runtime === 'codex' ? 'Codex' : 'Claude';
    const line = `${status} \`${s.sessionIdShort}\` · **${s.cwd}** · ${s.mode} · ${rt}`;
    const preview = s.lastMessage
      ? `\n> ${s.lastMessage.slice(0, 60)}${s.lastMessage.length > 60 ? '…' : ''}`
      : '';
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_align: 'left',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 4,
          elements: [{ tag: 'markdown', content: line + preview, text_size: 'normal' }],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: 'Resume' },
            type: 'primary',
            size: 'small',
            value: { callback_data: `resume:${s.bindingId}`, chatId },
          }],
        },
      ],
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Resume Session' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'history_outlined' },
    },
    body: { elements },
  });
}

// ── AskUserQuestion interactive form card ──────────────────

export interface AskUserQuestionDef {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * Build a CardKit v2 interactive form card for AskUserQuestion.
 */
export function buildAskUserQuestionCard(
  questionId: string,
  questions: AskUserQuestionDef[],
): string {
  const formElements: unknown[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    formElements.push({ tag: 'markdown', content: `**${q.question}**`, text_size: 'normal' });

    if (q.options && q.options.length > 0) {
      const optionItems = q.options.map((opt, idx) => ({
        text: { tag: 'plain_text' as const, content: opt.description ? `${opt.label} — ${opt.description}` : opt.label },
        value: `opt_${idx}_${opt.label}`,
      }));
      formElements.push(q.multiSelect
        ? { tag: 'multi_select_static', name: `q_${i}`, placeholder: { tag: 'plain_text', content: '选择一个或多个...' }, options: optionItems }
        : { tag: 'select_static', name: `q_${i}`, placeholder: { tag: 'plain_text', content: '选择...' }, options: optionItems }
      );
      // Always add a free-text input below options for custom answers
      formElements.push({ tag: 'markdown', content: '或者手动输入：', text_size: 'notation' });
      formElements.push({ tag: 'input', name: `q_${i}_custom`, placeholder: { tag: 'plain_text', content: '自定义回答（留空则使用上方选择）' } });
    } else {
      formElements.push({ tag: 'input', name: `q_${i}`, placeholder: { tag: 'plain_text', content: '输入回答...' } });
    }
  }

  formElements.push({
    tag: 'button', text: { tag: 'plain_text', content: '提交' },
    type: 'primary', size: 'medium',
    name: `ask_submit_${questionId}`, form_action_type: 'submit',
  });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '请回答' }, template: 'blue', icon: { tag: 'standard_icon', token: 'chat-bubble-question_outlined' } },
    body: { elements: [{ tag: 'form', name: 'ask_user_form', elements: formElements }] },
  });
}

/** Build an "answered" card to replace the form after submission. */
export function buildAskUserAnsweredCard(
  questions: AskUserQuestionDef[],
  answers: Record<string, string>,
): string {
  const lines = questions.map(q => `**${q.question}**\n✅ ${answers[q.question] || '(未回答)'}`);
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '已回答' }, template: 'green', icon: { tag: 'standard_icon', token: 'check-circle_outlined' } },
    body: {
      elements: [{
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: '查看回答' } },
        border: { color: 'green' },
        vertical_spacing: '8px',
        elements: [{ tag: 'markdown', content: lines.join('\n\n'), text_size: 'normal' }],
      }],
    },
  });
}
