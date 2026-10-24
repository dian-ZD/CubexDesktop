/**
 * 欢迎标语：按时段 + 梗/颜文字 + 功能贴士 + 鼓励四类混合随机。
 * 每次进入空会话页面时抽取，同一会话内保持不变（避免刷新跳变）。
 */

export interface WelcomeGreeting {
  /** 主标题 */
  title: string
  /** 副标题（可选） */
  subtitle?: string
}

const MORNING = [
  '早上好，今天也要元气满满地搬砖 ☀️',
  '早八人，代码和你都得清醒 ☕',
  '一日之计在于晨，先跑个测试压压惊 🌅',
  '早安。咖啡因已就位，就差你写的那行代码了 ☕',
]

const NOON = [
  '中午好，先吃饭还是先改 bug？都要的 🍚',
  '午安。.commit 之前记得多吃点 🍱',
  '下午茶时间写代码，效率翻倍（大概）🍵',
]

const EVENING = [
  '晚上好，正是写代码的好时候 🌆',
  '晚间档：今天想搞点什么呢？🌙',
  '晚风与终端更配哦 🌃',
]

const NIGHT = [
  '晚上好，夜猫子 🌙',
  '凌晨了还醒着？程序员生物钟认证 ✨',
  '这个时间用 Claude 早给你封号了 ¯\\_(ツ)_/¯',
  '深夜写代码，bug 都比较安静 🌌',
  '凌晨的 commit 有种特殊的浪漫 🌙',
]

const MEMES = [
  '它不是 bug，是未登记的功能 ¯\\_(ツ)_/¯',
  '代码能跑就别动它。真的。',
  '99 个小问题时你会说“还好”，第 100 个会爆炸 💥',
  '写代码五分钟，找分号两小时 🔍',
  '程序员的三大谎言：最后一个 commit、马上就好、这只是临时方案 😏',
  '今天也是与编译器斗智斗勇的一天 ⚔️',
  'Git push 之后才想起没跑测试？我们都懂 😅',
  '重启试试？重装试试？🤷',
]

const TIPS = [
  '试试输入 / 召唤技能和插件，比你想象的好用 ✨',
  '按 Ctrl+Enter 发送，Shift+Enter 换行，语音输入在麦克风图标里 🎙️',
  '复杂任务可以让 Cubex 拆成工作流：对它说「把这个流程做成工作流」🧩',
  '右栏能直接预览和编辑文件，改动 diff 一目了然 📂',
  'Work 画布支持思维导图式布局，分支任务一目了然 🗺️',
  '浏览器模式下 Cubex 能帮你读网页、查资料并标注来源 🔍',
  '设置里开启「token节省」能在大项目上省下不少上下文开销 💰',
]

const ENCOURAGE = [
  '每一次 git commit，都是更好的自己 🌱',
  '别急，慢慢来比较快 🐢',
  '今天的你比昨天的你多会一个快捷键 📈',
  '代码和人，有一个能跑就行 —— 都能跑最好 💪',
  '万事开头难，中间难，结尾难，但总会有 commit 的那一刻 🚀',
  '你已经比昨天多解决了一个问题 🎉',
]

const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)]!

/** 按当前小时返回欢迎标语：70% 概率时段问候，30% 概率梗/贴士/鼓励混合 */
export function welcomeGreeting(date = new Date()): WelcomeGreeting {
  const hour = date.getHours()
  const timeGreeting = hour < 5 ? pick(NIGHT) : hour < 11 ? pick(MORNING) : hour < 14 ? pick(NOON) : hour < 19 ? pick(EVENING) : pick(NIGHT)
  const roll = Math.random()
  if (roll < 0.55) return { title: timeGreeting }
  if (roll < 0.75) return { title: pick(MEMES) }
  if (roll < 0.9) return { title: pick(TIPS) }
  return { title: pick(ENCOURAGE), subtitle: timeGreeting }
}
