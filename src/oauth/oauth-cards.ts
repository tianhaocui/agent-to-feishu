/**
 * CardKit v2 cards for OAuth Device Flow authorization.
 */

/** Wrap URL in Feishu in-app browser applink. */
function toInAppWebUrl(url: string, domain: string): string {
  const isLark = domain.includes('larksuite');
  const scheme = isLark ? 'https://applink.larksuite.com' : 'https://applink.feishu.cn';
  const encoded = encodeURIComponent(url);
  return `${scheme}/client/web_url/open?mode=sidebar-semi&url=${encoded}&max_width=800`;
}

export function buildAuthCard(params: {
  verificationUriComplete: string;
  userCode: string;
  expiresIn: number;
  domain: string;
}): string {
  const authUrl = toInAppWebUrl(params.verificationUriComplete, params.domain);
  const expiresMin = Math.ceil(params.expiresIn / 60);

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '请授权以继续操作' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'key_outlined' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: '部分飞书操作需要你的授权才能执行（如搜索文档、读取日历等）。\n\n点击下方按钮完成授权，授权后 bot 即可代你操作飞书。', text_size: 'normal' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: [{
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '前往授权' },
              type: 'primary',
              size: 'medium',
              multi_url: { url: authUrl, pc_url: authUrl, android_url: authUrl, ios_url: authUrl },
            }],
          }],
        },
        { tag: 'markdown', content: `验证码：\`${params.userCode}\`　·　${expiresMin} 分钟内有效`, text_size: 'notation' },
      ],
    },
  });
}

export function buildAuthSuccessCard(): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '授权成功' },
      template: 'green',
      icon: { tag: 'standard_icon', token: 'check-circle_outlined' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: '飞书账号授权完成，bot 现在可以代你操作飞书了。', text_size: 'normal' },
      ],
    },
  });
}

export function buildAuthFailedCard(reason: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '授权未完成' },
      template: 'yellow',
      icon: { tag: 'standard_icon', token: 'warning_outlined' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: reason, text_size: 'normal' },
      ],
    },
  });
}
