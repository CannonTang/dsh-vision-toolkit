// 用宿主真实包验证:user/message 带 image 块 → 替换事件遮蔽模型历史
import { Session } from '/Users/windbylocus/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-session/lib/index.js';

const session = Session.create('spike-session');
const imageRef = { id: 'spike-img', mediaType: 'image/png', byteLength: 10, sha256: 'x'.repeat(64), name: 'a.png' };
session.append('user/message', {
  turn: 0, source: { kind: 'user' },
  id: 'm1', role: 'user',
  content: [
    { type: 'text', text: '请分析这张图' },
    { type: 'image', attachment: imageRef },
  ],
}, { surfaceOp: 'append' });
// 桥接替换事件(纯文本版)
session.append('user/message', {
  turn: 0, source: { kind: 'user' },
  id: 'm2', role: 'user',
  content: [
    { type: 'text', text: '请分析这张图' },
    { type: 'text', text: '[图片自动分析] 一张显示登录按钮的网页截图。' },
  ],
}, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] });

const messages = session.deriveMessages();
console.log('模型历史消息数:', messages.length);
for (const m of messages) {
  const hasImage = m.content.some((b) => b.type === 'image');
  console.log(`seq=${m.id} blocks=${m.content.length} hasImage=${hasImage}`);
}
if (messages.length !== 1 || messages[0].content.some((b) => b.type === 'image')) {
  throw new Error('SPIKE FAIL: 替换事件未遮蔽图片块');
}
console.log('SPIKE OK: surface replace 生效');
