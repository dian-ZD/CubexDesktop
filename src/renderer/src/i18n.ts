import { createContext, useCallback, useContext } from 'react'
import type { UiLanguage } from '../../shared/schema'

type Dict = Record<string, string>

const zh: Dict = {
  'brand.suffix': 'Desktop',
  'nav.newTask': '新建任务',
  'nav.projects': '项目',
  'nav.addProject': '添加项目',
  'nav.settings': '设置',
  'status.localWorkspace': '本地工作区',
  'status.running': '{n} 个会话进行中',
  'status.noModel': '未选择模型',
  'status.preview': '预览模式 · 不访问本机文件',
  'action.configureModel': '配置模型',
  'action.manageModels': '管理模型与审批',
  'onboarding.skip': '跳过',
  'onboarding.later': '稍后再说',
  'onboarding.prev': '上一步',
  'onboarding.next': '下一步',
  'onboarding.configure': '去配置模型',
  'onboarding.s1.title': '欢迎使用 CubexDesktop',
  'onboarding.s1.desc': '一个运行在本地的 AI 智能体助手。它可以在你的项目目录中读写文件、执行命令、联网检索，并自动完成多步骤的开发任务。',
  'onboarding.s2.title': '从添加项目开始',
  'onboarding.s2.desc': '在左侧「项目」中添加一个本地文件夹作为工作区，然后新建任务。所有文件操作都被限制在项目目录内，安全可控。',
  'onboarding.s3.title': '多智能体协作',
  'onboarding.s3.desc': '对于复杂任务，主智能体会自动拆解并委派多个子智能体并行处理，你可以在会话中看到「思考中 / 规划 / 委派」等实时状态。',
  'onboarding.s4.title': '配置模型即可上手',
  'onboarding.s4.desc': '前往设置添加模型提供商与 API Key，即可开始使用。你也可以稍后再配置。',
  'onboarding.agree.eula': '我已阅读并同意《用户协议》',
  'onboarding.agree.region': '我确认本人不在中华人民共和国境内',
  'onboarding.viewEula': '查看用户协议',
  'onboarding.mustAgree': '请先勾选上述两项后再继续',
  'onboarding.start': '开始使用',
  'onboarding.lang.title': '选择界面语言',
  'onboarding.lang.desc': '请先选择应用的界面显示语言，之后可随时在设置中更改。',
  'onboarding.step': '第 {n} 步 / 共 {total} 步',
  'eula.title': '用户协议',
  'eula.close': '关闭',
}

const en: Dict = {
  'brand.suffix': 'Desktop',
  'nav.newTask': 'New Task',
  'nav.projects': 'Projects',
  'nav.addProject': 'Add project',
  'nav.settings': 'Settings',
  'status.localWorkspace': 'Local workspace',
  'status.running': '{n} session(s) running',
  'status.noModel': 'No model selected',
  'status.preview': 'Preview mode · no local file access',
  'action.configureModel': 'Configure model',
  'action.manageModels': 'Manage models & approvals',
  'onboarding.skip': 'Skip',
  'onboarding.later': 'Later',
  'onboarding.prev': 'Back',
  'onboarding.next': 'Next',
  'onboarding.configure': 'Configure model',
  'onboarding.s1.title': 'Welcome to CubexDesktop',
  'onboarding.s1.desc': 'A local AI agent assistant. It reads and writes files in your project, runs commands, searches the web, and completes multi-step development tasks for you.',
  'onboarding.s2.title': 'Start by adding a project',
  'onboarding.s2.desc': 'Add a local folder as a workspace under "Projects" on the left, then create a task. All file operations stay within the project directory — safe and controlled.',
  'onboarding.s3.title': 'Multi-agent collaboration',
  'onboarding.s3.desc': 'For complex tasks, the main agent automatically breaks work down and delegates it to several sub-agents in parallel. You can watch live states like "thinking / planning / delegating" in the conversation.',
  'onboarding.s4.title': 'Configure a model to get going',
  'onboarding.s4.desc': 'Go to Settings to add a model provider and API key, then you are ready. You can also configure this later.',
  'onboarding.agree.eula': 'I have read and agree to the User Agreement',
  'onboarding.agree.region': 'I confirm I am not located within the mainland of the People\u2019s Republic of China',
  'onboarding.viewEula': 'View User Agreement',
  'onboarding.mustAgree': 'Please check both boxes above to continue',
  'onboarding.start': 'Get started',
  'onboarding.lang.title': 'Choose your language',
  'onboarding.lang.desc': 'Select the interface language first. You can change it anytime in Settings.',
  'onboarding.step': 'Step {n} of {total}',
  'eula.title': 'User Agreement',
  'eula.close': 'Close',
}

const dicts: Record<UiLanguage, Dict> = { 'zh-CN': zh, en }

export function translate(lang: UiLanguage, key: string, vars?: Record<string, string | number>): string {
  const template = dicts[lang]?.[key] ?? dicts['zh-CN'][key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`))
}

const zhEn: Record<string, string> = {}

export function registerPhrases(entries: Record<string, string>): void {
  for (const key of Object.keys(entries)) zhEn[key] = entries[key]
}

export function tr(lang: UiLanguage, zhText: string, vars?: Record<string, string | number>): string {
  const base = lang === 'en' ? (zhEn[zhText] ?? zhText) : zhText
  if (!vars) return base
  return base.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`))
}

export const LanguageContext = createContext<UiLanguage>('zh-CN')

export function useI18n(): {
  lang: UiLanguage
  t: (key: string, vars?: Record<string, string | number>) => string
  tr: (zhText: string, vars?: Record<string, string | number>) => string
} {
  const lang = useContext(LanguageContext)
  const translateKey = useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
  const translateText = useCallback((zhText: string, vars?: Record<string, string | number>) => tr(lang, zhText, vars), [lang])
  return {
    lang,
    t: translateKey,
    tr: translateText,
  }
}

const eulaZh = `CubexDesktop 用户协议

本软件 CubexDesktop（以下简称"本软件"）由 HIGHLIGHT STUDIO（以下简称"开发团队"）开发并享有全部权利。安装、使用本软件即表示你已阅读、理解并同意本协议的全部条款。

一、授权与使用
1. 开发团队授予你一项个人的、非独占的、不可转让的许可，允许你在遵守本协议的前提下使用本软件。
2. 本软件是一款在本地运行的 AI 智能体工具，你应对使用本软件执行的任何操作及其结果负责。

二、插件生态（鼓励开发）
1. 开发团队鼓励用户与第三方开发者为本软件开发插件、扩展与集成，共同繁荣生态。
2. 你可以自由地开发、分享插件，但插件不得包含恶意代码、后门、或损害用户设备与数据的功能。
3. 你开发的插件应遵守本协议及适用法律，尊重他人知识产权。

三、限制与禁止行为
1. 禁止直接倒卖、转售本软件本体，或以任何形式将本软件作为付费商品进行销售、出租、分发牟利。
2. 禁止利用插件机制进行售卖行为，包括但不限于：贩卖插件牟利、在插件中植入付费墙、向用户额外收取付费服务费用、通过插件变相销售本软件功能。
3. 禁止对本软件进行反向工程、反编译、破解授权机制，或去除、修改软件中的开发团队标识与版权信息。
4. 禁止将本软件用于任何违法、侵权或违反公序良俗的用途。
5. 禁止冒充开发团队 HIGHLIGHT STUDIO 或声称本软件由其他方开发。

四、知识产权
本软件的著作权、商标及其他相关知识产权均归 HIGHLIGHT STUDIO 所有。本协议未明确授予的权利，开发团队保留一切权利。

五、免责声明
本软件按"现状"提供，开发团队不对其适用性、稳定性作任何明示或默示担保。因使用本软件（含 AI 生成内容、命令执行、文件修改）造成的任何损失，由使用者自行承担。

六、协议变更与终止
开发团队有权更新本协议。若你违反本协议，开发团队有权终止对你的授权。

继续使用本软件即表示你同意以上全部条款。`

const eulaEn = `CubexDesktop User Agreement

CubexDesktop (the "Software") is developed by and fully owned by HIGHLIGHT STUDIO (the "Team"). By installing or using the Software, you acknowledge that you have read, understood, and agreed to all terms of this Agreement.

1. License and Use
1.1 The Team grants you a personal, non-exclusive, non-transferable license to use the Software subject to this Agreement.
1.2 The Software is a locally running AI agent tool. You are responsible for all actions performed with it and their outcomes.

2. Plugin Ecosystem (Development Encouraged)
2.1 The Team encourages users and third-party developers to build plugins, extensions, and integrations for the Software.
2.2 You may freely develop and share plugins, provided they contain no malicious code, backdoors, or features that harm user devices or data.
2.3 Your plugins must comply with this Agreement and applicable law, and respect others' intellectual property.

3. Restrictions and Prohibitions
3.1 You may not resell, redistribute for profit, rent, or sell the Software itself as a paid product in any form.
3.2 You may not use the plugin mechanism for commercial resale, including but not limited to: selling plugins for profit, embedding paywalls, charging users for paid services, or indirectly selling the Software's functionality through plugins.
3.3 You may not reverse engineer, decompile, crack the licensing mechanism, or remove/modify the Team's identifiers and copyright notices.
3.4 You may not use the Software for any unlawful, infringing, or unethical purpose.
3.5 You may not impersonate HIGHLIGHT STUDIO or claim the Software was developed by any other party.

4. Intellectual Property
All copyrights, trademarks, and related intellectual property of the Software belong to HIGHLIGHT STUDIO. All rights not expressly granted are reserved.

5. Disclaimer
The Software is provided "as is" without warranty of any kind. The Team is not liable for any loss arising from use of the Software (including AI-generated content, command execution, or file modification).

6. Changes and Termination
The Team may update this Agreement. The Team may terminate your license if you violate this Agreement.

By continuing to use the Software, you agree to all of the above terms.`

export function eulaText(lang: UiLanguage): string {
  return lang === 'en' ? eulaEn : eulaZh
}
