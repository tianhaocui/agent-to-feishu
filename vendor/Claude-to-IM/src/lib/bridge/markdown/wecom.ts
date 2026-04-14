/**
 * WeCom markdown conversion utilities.
 *
 * WeCom markdown supports: headings, **bold**, `inline code`, ```code blocks```,
 * [links](url), > quotes.
 * Does NOT support: *italic*, ~~strikethrough~~, images, tables, ordered lists.
 */

/**
 * Convert standard markdown to WeCom-compatible markdown.
 */
export function toWeComMarkdown(text: string): string {
  let result = text;

  // Remove images: ![alt](url)
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Remove strikethrough: ~~text~~ → text
  result = result.replace(/~~([^~]+)~~/g, '$1');

  // Convert italic (single *) to plain text, but preserve bold (**)
  // Match *text* that is NOT **text**
  result = result.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, '$1');

  // Convert tables to indented plain text
  result = result.replace(
    /(?:^|\n)(\|.+\|(?:\n\|[-:| ]+\|)?(?:\n\|.+\|)*)/g,
    (_match, table: string) => {
      const lines = table.trim().split('\n');
      const rows: string[][] = [];
      for (const line of lines) {
        // Skip separator rows (|---|---|)
        if (/^\|[\s\-:|]+\|$/.test(line)) continue;
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        rows.push(cells);
      }
      if (rows.length === 0) return '';
      // Format as indented lines
      const header = rows[0];
      const dataRows = rows.slice(1);
      const out: string[] = [];
      for (const row of dataRows) {
        const parts = row.map((cell, i) => `${header[i] || ''}: ${cell}`);
        out.push(parts.join('  |  '));
      }
      return '\n' + out.join('\n');
    },
  );

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * Convert HTML to WeCom-compatible markdown.
 * Used for permission-broker HTML output.
 */
export function htmlToWeComMarkdown(html: string): string {
  let text = html;

  // Bold
  text = text.replace(/<\/?b>/gi, '**');
  text = text.replace(/<\/?strong>/gi, '**');

  // Inline code
  text = text.replace(/<code>([^<]*)<\/code>/gi, '`$1`');

  // Links
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)');

  // Line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Paragraphs
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Clean up
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
