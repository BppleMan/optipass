export enum IconShapeKind {
  Circle = 'circle', Ellipse = 'ellipse', Rect = 'rect', Path = 'path',
}

export interface IconShape {
  kind: IconShapeKind;
  cx?: number;
  cy?: number;
  r?: number;
  rx?: number;
  ry?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  d?: string;
  fill?: boolean;
  dash?: string;
}

export interface IconDefinition {
  name: string;
  shapes: IconShape[];
}

export interface VaultIconDefinition extends IconDefinition {
  keywords: string[];
}

export const iconPalette = ['#f07178', '#f78c6c', '#ffcb6b', '#c3e88d', '#89ddff', '#82aaff', '#c792ea'];

export const vaultIconDefinitions: VaultIconDefinition[] = [
  {
    name: 'lock',
    keywords: ['private', 'secret', 'password', '私密', '密码', '隐私', 'confidential', '保密', 'secure', '私人'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 6, y: 10.5, width: 12, height: 9, rx: 2.2 },
      { kind: IconShapeKind.Path, d: 'M8.5 10.5 V8 A3.5 3.5 0 0 1 15.5 8 V10.5' },
      { kind: IconShapeKind.Circle, cx: 12, cy: 15, r: 1.4, fill: true }
    ]
  },
  {
    name: 'key',
    keywords: ['key', 'token', 'api', '密钥', '钥匙', 'credential', 'access', 'auth', 'apikey', '授权'],
    shapes: [
      { kind: IconShapeKind.Circle, cx: 8.5, cy: 12, r: 3.5 },
      { kind: IconShapeKind.Path, d: 'M12 12 H19.5 M17 12 V15 M14.5 12 V14' }
    ]
  },
  {
    name: 'shield',
    keywords: ['security', 'vpn', '安全', 'firewall', 'protect', '防护', 'defense', 'guard', 'secure', '安全组'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M12 4.5 L18.5 7 V12 C18.5 16 15.8 18.5 12 20 C8.2 18.5 5.5 16 5.5 12 V7 Z' },
      { kind: IconShapeKind.Path, d: 'M9.5 12 L11.3 13.8 L14.8 10' }
    ]
  },
  {
    name: 'cdn',
    keywords: ['cloudflare', 'cdn', 'dns', 'edge', '加速', 'proxy', '反代', 'worker', 'pages', '网络加速'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M7 15.5 A3.2 3.2 0 0 1 7.5 9.2 A4.6 4.6 0 0 1 16.5 8.5 A3.4 3.4 0 0 1 17 15.5 Z' },
      { kind: IconShapeKind.Path, d: 'M7.5 19 H11 M13.5 19 H16.5' }
    ]
  },
  {
    name: 'cloud',
    keywords: ['icloud', 'cloud', '云', '云盘', 'onedrive', 'dropbox', 'storage', '云存储', 'drive', 'sync'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M7 18 A3.8 3.8 0 0 1 7.4 10.4 A5.2 5.2 0 0 1 17.4 9.6 A3.8 3.8 0 0 1 17.5 18 Z' }]
  },
  {
    name: 'globe',
    keywords: ['chrome', 'browser', 'web', '浏览器', 'firefox', 'safari', '谷歌', 'internet', '网页', 'google'],
    shapes: [
      { kind: IconShapeKind.Circle, cx: 12, cy: 12, r: 7.5 },
      { kind: IconShapeKind.Path, d: 'M4.5 12 H19.5 M12 4.5 C9 7.5 9 16.5 12 19.5 C15 16.5 15 7.5 12 4.5' }
    ]
  },
  {
    name: 'flask',
    keywords: ['mock', 'test', 'demo', '测试', 'sandbox', 'staging', '沙盒', 'experiment', 'trial', '样例'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M10 4.5 H14 M11 4.5 V9.5 L6.5 17 A1.8 1.8 0 0 0 8 19.5 H16 A1.8 1.8 0 0 0 17.5 17 L13 9.5 V4.5' },
      { kind: IconShapeKind.Circle, cx: 10.5, cy: 15.5, r: 1.1, fill: true },
      { kind: IconShapeKind.Circle, cx: 13.8, cy: 17, r: 0.9, fill: true }
    ]
  },
  {
    name: 'chat',
    keywords: ['chat', 'message', '聊天', '消息', 'im', '私信', 'wechat', 'telegram', '聊', '对话'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M4.5 7 H15.5 V13.5 H8 L4.5 16.5 Z' },
      { kind: IconShapeKind.Path, d: 'M17.5 10.5 H19.5 V17 L16.5 14.8 H10.5 V13.5' }
    ]
  },
  {
    name: 'chat-heart',
    keywords: ['暖', 'love', '恋爱', 'romance', '情侣', 'dating', 'couple', '暖语', 'sweet', '甜蜜'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M5 6.5 H19 V15 H12.5 L9 18.5 V15 H5 Z' },
      { kind: IconShapeKind.Path, d: 'M12 12.6 C10 11 9 9.6 10.2 8.6 C11 8 12 8.5 12 9.3 C12 8.5 13 8 13.8 8.6 C15 9.6 14 11 12 12.6 Z', fill: true }
    ]
  },
  {
    name: 'chat-alert',
    keywords: ['诉', 'feedback', '反馈', 'complaint', '投诉', 'appeal', '申诉', 'report', 'issue', '求助'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M5 6.5 H19 V15 H12.5 L9 18.5 V15 H5 Z' },
      { kind: IconShapeKind.Path, d: 'M12 8.3 V11.3' },
      { kind: IconShapeKind.Circle, cx: 12, cy: 13.3, r: 1, fill: true }
    ]
  },
  {
    name: 'people',
    keywords: ['shared', 'share', 'team', '共享', '家庭', 'family', 'group', '团队', 'collab', '协作'],
    shapes: [
      { kind: IconShapeKind.Circle, cx: 9, cy: 9.5, r: 3 },
      { kind: IconShapeKind.Path, d: 'M4.5 18.5 A4.5 4.5 0 0 1 13.5 18.5' },
      { kind: IconShapeKind.Circle, cx: 16.5, cy: 10.5, r: 2.3 },
      { kind: IconShapeKind.Path, d: 'M15.5 18.5 A4 4 0 0 0 20 15.2' }
    ]
  },
  {
    name: 'person',
    keywords: ['personal', 'me', '个人', 'myself', '自己', 'profile', '本人', 'single', '独立', 'own'],
    shapes: [
      { kind: IconShapeKind.Circle, cx: 12, cy: 8.5, r: 3.5 },
      { kind: IconShapeKind.Path, d: 'M5.5 19.5 A6.5 6.5 0 0 1 18.5 19.5' }
    ]
  },
  {
    name: 'home',
    keywords: ['home', 'house', '家', 'residence', '住宅', 'household', '居家', 'smarthome', 'family', '家里'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M5 11.5 L12 5 L19 11.5 M7 10.5 V19 H17 V10.5' }]
  },
  {
    name: 'briefcase',
    keywords: ['work', 'company', 'job', '工作', '公司', 'office', '职场', 'business', 'career', '上班'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 8.5, width: 15, height: 10.5, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M9 8.5 V6.5 A1.5 1.5 0 0 1 10.5 5 H13.5 A1.5 1.5 0 0 1 15 6.5 V8.5 M4.5 13 H19.5' }
    ]
  },
  {
    name: 'code',
    keywords: ['dev', 'code', 'git', '开发', 'github', 'gitlab', 'programming', '代码', 'engineer', '编程'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M9 8 L5 12 L9 16 M15 8 L19 12 L15 16' }]
  },
  {
    name: 'server',
    keywords: ['server', 'host', '服务器', 'hosting', 'vps', '主机', 'node', 'cluster', '部署', 'deploy'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 5, y: 5, width: 14, height: 6, rx: 1.5 },
      { kind: IconShapeKind.Rect, x: 5, y: 13, width: 14, height: 6, rx: 1.5 },
      { kind: IconShapeKind.Circle, cx: 8.2, cy: 8, r: 1, fill: true },
      { kind: IconShapeKind.Circle, cx: 8.2, cy: 16, r: 1, fill: true }
    ]
  },
  {
    name: 'database',
    keywords: ['database', 'db', 'sql', '数据库', 'mysql', 'postgres', 'mongodb', '数据', 'redis', 'table'],
    shapes: [
      { kind: IconShapeKind.Ellipse, cx: 12, cy: 6.5, rx: 6.5, ry: 2.5 },
      { kind: IconShapeKind.Path, d: 'M5.5 6.5 V17.5 C5.5 18.9 8.4 20 12 20 C15.6 20 18.5 18.9 18.5 17.5 V6.5 M5.5 12 C5.5 13.4 8.4 14.5 12 14.5 C15.6 14.5 18.5 13.4 18.5 12' }
    ]
  },
  {
    name: 'terminal',
    keywords: ['terminal', 'shell', 'ssh', 'bash', '终端', 'cli', 'console', '命令行', 'root', 'linux'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 13, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M7.5 9.5 L10.5 12 L7.5 14.5 M12.5 15 H16' }
    ]
  },
  {
    name: 'card',
    keywords: ['card', 'pay', '支付', '银行卡', 'creditcard', 'debit', 'visa', 'mastercard', '信用卡', 'payment'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 6.5, width: 15, height: 11, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M4.5 10.5 H19.5 M7.5 14.5 H11' }
    ]
  },
  {
    name: 'coin',
    keywords: ['finance', 'bank', 'money', '财务', '钱', '银行', 'wealth', 'savings', '储蓄', '资金'],
    shapes: [
      { kind: IconShapeKind.Circle, cx: 12, cy: 12, r: 7.5 },
      { kind: IconShapeKind.Path, d: 'M9 9.5 L12 12.5 L15 9.5 M9.5 12.5 H14.5 M9.5 15 H14.5 M12 12.5 V17' }
    ]
  },
  {
    name: 'chart',
    keywords: ['invest', 'trade', 'stock', '股票', '投资', '交易', 'portfolio', '基金', 'fund', 'crypto'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M5 19 H19 M5 19 V5 M7.5 15.5 L11 11.5 L13.5 13.5 L18 8' }]
  },
  {
    name: 'cart',
    keywords: ['shop', 'buy', '购物', '淘宝', 'shopping', 'ecommerce', '电商', 'taobao', 'jd', 'store'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M4.5 5.5 H7 L9 15 H17.5 L19.5 8 H7.6' },
      { kind: IconShapeKind.Circle, cx: 10, cy: 18.5, r: 1.4, fill: true },
      { kind: IconShapeKind.Circle, cx: 16.5, cy: 18.5, r: 1.4, fill: true }
    ]
  },
  {
    name: 'gift',
    keywords: ['gift', '礼物', 'present', 'birthday', '生日', 'coupon', '优惠券', 'reward', '红包', 'voucher'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 5, y: 9.5, width: 14, height: 10, rx: 1.5 },
      { kind: IconShapeKind.Path, d: 'M12 9.5 V19.5 M5 13 H19 M12 9.5 C9.5 9.5 7.5 8.5 8 6.8 C8.5 5.2 11 5.5 12 9.5 C13 5.5 15.5 5.2 16 6.8 C16.5 8.5 14.5 9.5 12 9.5' }
    ]
  },
  {
    name: 'mail',
    keywords: ['mail', 'gmail', 'outlook', '邮箱', 'email', 'inbox', '163', 'qqmail', '电邮', '邮件'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 6.5, width: 15, height: 11, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M5 7.5 L12 13 L19 7.5' }
    ]
  },
  {
    name: 'phone',
    keywords: ['phone', 'mobile', '手机', 'sim', 'cellphone', '电话', 'contact', '通讯录', 'telecom', '运营商'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 7.5, y: 4.5, width: 9, height: 15, rx: 2.2 },
      { kind: IconShapeKind.Path, d: 'M10.5 16.8 H13.5' }
    ]
  },
  {
    name: 'note',
    keywords: ['note', 'doc', '笔记', '文档', 'notion', 'evernote', 'memo', '备忘录', '记事', 'writing'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M6 4.5 H14.5 L18 8 V19.5 H6 Z M14.5 4.5 V8 H18' },
      { kind: IconShapeKind.Path, d: 'M9 12 H15 M9 15 H13' }
    ]
  },
  {
    name: 'health',
    keywords: ['health', 'medical', '健康', '医院', 'doctor', 'hospital', 'clinic', '病历', 'wellness', '医疗'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M12 19 C7 15.5 4.5 12.5 4.5 9.5 A3.8 3.8 0 0 1 12 8 A3.8 3.8 0 0 1 19.5 9.5 C19.5 12.5 17 15.5 12 19 Z' },
      { kind: IconShapeKind.Path, d: 'M8.5 12 H10.5 L11.7 9.8 L13 13.6 L14 12 H15.5' }
    ]
  },
  {
    name: 'star',
    keywords: ['favorite', 'star', '收藏', '常用', 'bookmark', 'top', 'pinned', '置顶', 'important', '重要'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M12 4.5 L14.2 9.4 L19.5 10 L15.5 13.6 L16.6 18.9 L12 16.2 L7.4 18.9 L8.5 13.6 L4.5 10 L9.8 9.4 Z' }]
  },
  {
    name: 'wrench',
    keywords: ['tool', 'util', '工具', 'utility', 'setting', 'config', '配置', 'maintenance', '维护', 'repair'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M14.5 4.8 A4.8 4.8 0 0 0 9.2 11.4 L4.8 15.8 A2 2 0 0 0 8.2 19.2 L12.6 14.8 A4.8 4.8 0 0 0 19.2 9.5 L16 12.7 L11.3 8 Z' }]
  },
  {
    name: 'wifi',
    keywords: ['wifi', 'network', 'router', '网络', '路由器', 'broadband', '宽带', 'modem', 'connection', '局域网'],
    shapes: [
      { kind: IconShapeKind.Path, d: 'M4.5 10 A11 11 0 0 1 19.5 10 M7.3 13 A7 7 0 0 1 16.7 13 M10 16 A3 3 0 0 1 14 16' },
      { kind: IconShapeKind.Circle, cx: 12, cy: 18.5, r: 1.3, fill: true }
    ]
  },
  {
    name: 'archive',
    keywords: ['archive', 'backup', 'old', '归档', '备份', '旧', 'legacy', 'coldstorage', '存档', 'deprecated'],
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 4.5, rx: 1.2 },
      { kind: IconShapeKind.Path, d: 'M6 10 V17 A1.5 1.5 0 0 0 7.5 18.5 H16.5 A1.5 1.5 0 0 0 18 17 V10 M10 13 H14' }
    ]
  },
  {
    name: 'folder',
    keywords: ['vault', 'misc', '其他', 'default', 'general', '杂项', 'unnamed', 'unknown', '未分类', 'other'],
    shapes: [{ kind: IconShapeKind.Path, d: 'M4.5 6.5 H10 L12 9 H19.5 V18.5 H4.5 Z' }]
  }
];

export const itemTypeIconDefinitions: Record<string, IconDefinition> = {
  login: {
    name: 'login',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 13, rx: 2 },
      { kind: IconShapeKind.Circle, cx: 12, cy: 10.5, r: 2.2 },
      { kind: IconShapeKind.Path, d: 'M8 16.5 A4.2 3.4 0 0 1 16 16.5' }
    ]
  },
  'secure-note': {
    name: 'secure-note',
    shapes: [
      { kind: IconShapeKind.Path, d: 'M5.5 4.5 H18.5 V19.5 H5.5 Z' },
      { kind: IconShapeKind.Path, d: 'M8.5 8 H15.5 M8.5 11 H15.5 M8.5 14 H12' },
      { kind: IconShapeKind.Rect, x: 13.2, y: 15, width: 6, height: 4.6, rx: 1.2 },
      { kind: IconShapeKind.Path, d: 'M14.5 15 V14 A1.7 1.7 0 0 1 17.9 14 V15' }
    ]
  },
  'credit-card': vaultIconDefinitions.find((icon) => icon.name === 'card')!,
  identity: vaultIconDefinitions.find((icon) => icon.name === 'person')!,
  password: {
    name: 'password',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 8, width: 15, height: 8, rx: 2 },
      { kind: IconShapeKind.Circle, cx: 8.5, cy: 12, r: 1.2, fill: true },
      { kind: IconShapeKind.Circle, cx: 12, cy: 12, r: 1.2, fill: true },
      { kind: IconShapeKind.Circle, cx: 15.5, cy: 12, r: 1.2, fill: true }
    ]
  },
  document: vaultIconDefinitions.find((icon) => icon.name === 'note')!,
  'ssh-key': {
    name: 'ssh-key',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 13, rx: 2 },
      { kind: IconShapeKind.Circle, cx: 9, cy: 12, r: 2 },
      { kind: IconShapeKind.Path, d: 'M11 12 H16.5 M15 12 V14 M13 12 V13.5' }
    ]
  },
  'api-credential': {
    name: 'api-credential',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 13, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M9.5 9.5 L7 12 L9.5 14.5 M14.5 9.5 L17 12 L14.5 14.5' }
    ]
  },
  database: vaultIconDefinitions.find((icon) => icon.name === 'database')!,
  server: vaultIconDefinitions.find((icon) => icon.name === 'server')!,
  'software-license': {
    name: 'software-license',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 11, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M8.5 8.5 H15.5 M8.5 11 H13' },
      { kind: IconShapeKind.Circle, cx: 15.5, cy: 15.5, r: 2.4 },
      { kind: IconShapeKind.Path, d: 'M14.2 17.5 L13.5 20 L15.5 19 L17.5 20 L16.8 17.5' }
    ]
  },
  'crypto-wallet': {
    name: 'crypto-wallet',
    shapes: [
      { kind: IconShapeKind.Path, d: 'M4.5 8 A2 2 0 0 1 6.5 6 H17 V8.5' },
      { kind: IconShapeKind.Path, d: 'M4.5 8 V17.5 A2 2 0 0 0 6.5 19.5 H19.5 V8.5 H4.5' },
      { kind: IconShapeKind.Circle, cx: 15.8, cy: 14, r: 1.4, fill: true }
    ]
  },
  membership: vaultIconDefinitions.find((icon) => icon.name === 'star')!,
  'medical-record': vaultIconDefinitions.find((icon) => icon.name === 'health')!,
  rewards: vaultIconDefinitions.find((icon) => icon.name === 'gift')!,
  'outdoor-license': {
    name: 'outdoor-license',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 5.5, width: 15, height: 13, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M7 15.5 L10 10.5 L12.5 14 L14 12 L17 15.5 Z', fill: true },
      { kind: IconShapeKind.Circle, cx: 15.5, cy: 9, r: 1.2, fill: true }
    ]
  },
  passport: {
    name: 'passport',
    shapes: [
      { kind: IconShapeKind.Rect, x: 6, y: 4.5, width: 12, height: 15, rx: 2 },
      { kind: IconShapeKind.Circle, cx: 12, cy: 10.5, r: 2.8 },
      { kind: IconShapeKind.Path, d: 'M9.2 10.5 H14.8 M12 7.7 C10.7 9 10.7 12 12 13.3 C13.3 12 13.3 9 12 7.7 M9 16.5 H15' }
    ]
  },
  router: vaultIconDefinitions.find((icon) => icon.name === 'wifi')!,
  email: vaultIconDefinitions.find((icon) => icon.name === 'mail')!,
  'social-security-number': {
    name: 'social-security-number',
    shapes: [
      { kind: IconShapeKind.Rect, x: 4.5, y: 6.5, width: 15, height: 11, rx: 2 },
      { kind: IconShapeKind.Path, d: 'M9 10 V14 M12 10 V14 M15 10 V14 M7.7 11.3 H10.3 M13.7 12.7 H16.3' }
    ]
  },
  'bank-account': vaultIconDefinitions.find((icon) => icon.name === 'coin')!,
  person: vaultIconDefinitions.find((icon) => icon.name === 'person')!,
  'driver-license': vaultIconDefinitions.find((icon) => icon.name === 'person')!,
  other: vaultIconDefinitions.find((icon) => icon.name === 'folder')!
};

export const itemTypeColorIndex: Record<string, number> = {
  password: 0,
  'ssh-key': 1,
  'api-credential': 2,
  login: 5,
  database: 4,
  'secure-note': 6,
  'credit-card': 3,
  document: 4,
  identity: 3,
  server: 5,
  'software-license': 2,
  'crypto-wallet': 6,
  membership: 3,
  'medical-record': 0,
  rewards: 2,
  'outdoor-license': 3,
  passport: 5,
  router: 4,
  email: 5,
  'social-security-number': 6,
  'bank-account': 2,
  person: 3,
  'driver-license': 5,
  other: 4
};

export function normalizeIndex(index: number, size: number): number {
  return ((Math.trunc(index) % size) + size) % size;
}

export function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hexToRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
}

export function colorForIndex(index: number): string {
  return iconPalette[normalizeIndex(index, iconPalette.length)];
}

export function resolveVaultIcon(vaultName: string, fallbackIndex: number): { definition: VaultIconDefinition; color: string } {
  const lowerName = vaultName.toLowerCase();
  const matchedIndex = vaultIconDefinitions.findIndex((definition) =>
    definition.keywords.some((keyword) => lowerName.includes(keyword.toLowerCase()))
  );
  const definitionIndex = matchedIndex >= 0 ? matchedIndex : stableHash(vaultName) % vaultIconDefinitions.length;
  const colorIndex = stableHash(`${vaultName}:${fallbackIndex}`) % iconPalette.length;
  return {
    definition: vaultIconDefinitions[definitionIndex],
    color: colorForIndex(colorIndex)
  };
}

export function resolveItemTypeIcon(type: string): { definition: IconDefinition; color: string } {
  const normalizedType = type in itemTypeIconDefinitions ? type : 'other';
  return {
    definition: itemTypeIconDefinitions[normalizedType],
    color: colorForIndex(itemTypeColorIndex[normalizedType] ?? stableHash(normalizedType))
  };
}
