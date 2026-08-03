/**
 * Locale strings for workflow TUI.
 *
 * Defaults to English; set OPENCLI_LOCALE=zh for Chinese.
 */

export interface WorkflowLocale {
  confirm_yes: string;
  confirm_no: string;
  auth_open_browser: string;
  auth_skip: string;
  auth_abort: string;
  hint_space_select: string;
  hint_move: string;
  hint_enter: string;
  hint_esc_hide: string;
  hint_esc_exit: string;
  hint_switch_tabs: string;
  hint_fold: string;
  hint_reopen_interact: string;
  hint_open_output: string;
  auth_browser_opened: (site: string) => string;
  auth_needs_login: (site: string) => string;
}

export const EN: WorkflowLocale = {
  confirm_yes: 'Yes',
  confirm_no: 'No',
  auth_open_browser: 'Open browser to login',
  auth_skip: 'Skip this step',
  auth_abort: 'Abort workflow',
  hint_space_select: 'space select',
  hint_move: '↑↓ move',
  hint_enter: 'enter confirm',
  hint_esc_hide: 'esc hide',
  hint_esc_exit: 'esc exit',
  hint_switch_tabs: '←/→ switch',
  hint_fold: '←/→ fold/expand',
  hint_reopen_interact: 'enter reopen interact',
  hint_open_output: 'o open output',
  auth_browser_opened: (site) => `Browser opened for ${site} login. Press Enter when done.`,
  auth_needs_login: (site) => `${site} requires login`,
};

export const ZH: WorkflowLocale = {
  confirm_yes: '确认',
  confirm_no: '取消',
  auth_open_browser: '打开浏览器登录',
  auth_skip: '跳过此步骤',
  auth_abort: '终止工作流',
  hint_space_select: 'space 选择',
  hint_move: '↑↓ 移动',
  hint_enter: 'enter 确认',
  hint_esc_hide: 'esc 隐藏',
  hint_esc_exit: 'esc 退出',
  hint_switch_tabs: '←/→ 切换',
  hint_fold: '←/→ 折叠展开',
  hint_reopen_interact: 'enter 唤起交互',
  hint_open_output: 'o 打开输出',
  auth_browser_opened: (site) => `浏览器已打开 ${site} 登录页，完成后按 Enter 继续`,
  auth_needs_login: (site) => `${site} 需要登录`,
};

export function getLocale(): WorkflowLocale {
  const lang = process.env.OPENCLI_LOCALE
    || process.env.LANG?.split('.')[0]
    || 'en';
  return lang.startsWith('zh') ? ZH : EN;
}
