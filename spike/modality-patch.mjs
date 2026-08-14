// 验证 cordis proxy 上能否直接给服务方法赋值;不可写则验证原型链补丁
import { Context } from '/Users/windbylocus/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';

const ctx = new Context();
ctx.provide('llm', {
  resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
});

// 方式 1:实例属性赋值
let applied = false;
try {
  const orig = ctx.llm.resolveModelInfo;
  ctx.llm.resolveModelInfo = async (p, m, s) => {
    const info = await orig.call(ctx.llm, p, m, s);
    return { ...info, inputModalities: ['text', 'image'] };
  };
  applied = ctx.llm.resolveModelInfo !== orig;
} catch { applied = false; }

// 方式 2:原型链补丁
let protoApplied = false;
if (!applied) {
  const proto = Object.getPrototypeOf(ctx.llm);
  const origProto = proto.resolveModelInfo;
  if (typeof origProto === 'function') {
    proto.resolveModelInfo = function (p, m, s) {
      return origProto.call(this, p, m, s).then((info) => ({ ...info, inputModalities: ['text', 'image'] }));
    };
    protoApplied = true;
  }
}
console.log(`instance-patch=${applied} proto-patch=${protoApplied}`);
if (!applied && !protoApplied) throw new Error('SPIKE FAIL: 两种补丁方式都不可行,需回规划');
const info = await ctx.llm.resolveModelInfo('deepseek', 'chat');
console.log('inputModalities =', info.inputModalities);
if (!info.inputModalities.includes('image')) throw new Error('SPIKE FAIL: 补丁未生效');
console.log('SPIKE OK: 模态补丁生效');
