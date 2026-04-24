import type { OrchTask } from './types.js';

const STATUS_ICONS: Record<string, string> = {
  queued: '⏳',
  assigned: '📤',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  cancelled: '⏹️',
};

export function buildTaskBoardCard(parentTask: OrchTask, subTasks: OrchTask[]): string {
  const completed = subTasks.filter(t => t.status === 'completed').length;
  const total = subTasks.length;

  const taskLines = subTasks.map(t => {
    const icon = STATUS_ICONS[t.status] || '❓';
    const worker = t.assignedTo ? ` → ${t.assignedTo}` : '';
    const suffix = t.status === 'failed' && t.error ? ` (${t.error.slice(0, 50)})` : '';
    return `${icon} ${t.description}${worker}${suffix}`;
  }).join('\n');

  const headerTemplate = total > 0 && completed === total ? 'green' : 'blue';
  const headerTitle = total > 0 && completed === total ? '任务完成' : '任务看板';

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: headerTemplate,
      icon: { tag: 'standard_icon', token: completed === total ? 'check-circle_outlined' : 'task_outlined' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**用户请求:** ${parentTask.description.slice(0, 200)}`, text_size: 'normal' },
        { tag: 'hr' },
        { tag: 'markdown', content: taskLines || '(无子任务)', text_size: 'normal' },
        { tag: 'hr' },
        { tag: 'markdown', content: `**进度:** ${completed}/${total} 完成`, text_size: 'notation' },
      ],
    },
  });
}

export function buildSummaryCard(parentTask: OrchTask, summary: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '任务汇总' },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'check-circle_outlined' },
    },
    body: {
      elements: [
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: `原始请求: ${parentTask.description.slice(0, 60)}` } },
          border: { color: 'grey' },
          vertical_spacing: '8px',
          elements: [{ tag: 'markdown', content: parentTask.description, text_size: 'normal' }],
        },
        { tag: 'hr' },
        { tag: 'markdown', content: summary, text_size: 'normal' },
      ],
    },
  });
}
