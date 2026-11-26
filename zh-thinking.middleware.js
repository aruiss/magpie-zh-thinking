// zh-thinking.middleware.js — magpie 网关中间件（moejs，运行在网关进程内）
//
// 目的：让经过 magpie 的请求「用简体中文思考（thinking）」并且「用简体中文回答」。
//
// 为什么不能只改 system：实测（WorkBuddy 通道，deepseek-v4.1-flash）把
// 「用中文思考」写进 system，回复会变中文，但 thinking 仍是英文；把同一句
// 要求放进用户消息（尤其是最后一条独立的 user 消息）thinking 才会变中文。
// 所以这里两处都做：system 末尾追加（保留 prompt cache），用户消息里再放一次。
//
// 开关（plugins.json 的 options，或 `magpie plugin options zh-thinking '{...}'`）：
//   zh             true（默认）| false：中文注入总开关
//   process        true | false（默认）：过程提示总开关
//   zh_mode        "both"（默认）| "system" | "user"：中文指令放在哪
//   system_prompt  自定义 system 中文指令（默认英文）
//   user_prompt    自定义用户消息中文指令（默认中文）
//   process_hint   自定义过程提示（空 = 内置默认）
//   process_in     "system"（默认）| "user" | "both"：过程提示放在哪
//   thinking       "auto"（默认，不改）| "on" | "off"：思维链开关。
//                  off 用 Anthropic 的 thinking.disabled、chat 的
//                  reasoning_effort "off"、Responses 的 reasoning.effort
//                  "none"、Gemini 的 thinkingBudget 0。
//   thinking_budget  on 时 Anthropic 的 budget_tokens（默认 2048）
//   thinking_effort  on 时 chat/responses 的 effort（默认 "high"）
//   user_inject    "anthropic"（默认）| "always" | "never"：是否改用户消息。
//                  默认只对 Anthropic 协议改（Claude Code 不会回写请求体）；
//                  chat/responses 只改 system，因为有些客户端（DSH）会把注入的
//                  用户消息回显成新的用户输入，形成循环。
//   agents         只对这些 agent id 生效（空 = 全部），如 ["claude","codex"]
//   models         只对这些模型名前缀生效（空 = 全部），如 ["deepseek","group/"]
//
// 注意：真正的「工具调用卡片」是客户端（DSH/Claude Code/Codex）按 tool_calls
// 渲染的，中间件改不了别人的 UI，只能让模型多写过程文字。
//
// 说明：
// - 最后一条 user 是纯文本时，把指令拼在它开头（不新增消息，实测有效）；
// - 最后一条 user 带 tool_result（Claude Code 的工具轮次）时，追加一条独立的
//   user 消息——塞进 tool_result 里模型不会当指令（实测）；
// - 只改 messages/system，不改 model、stream、工具声明，网关不会回滚。

const SYSTEM_PROMPT =
  'Think in Simplified Chinese. Write your entire reasoning in Simplified Chinese, and answer the user in Simplified Chinese.';
const USER_PROMPT = '请全程用简体中文思考（包括 thinking 推理过程），并用简体中文回答。';
const PROCESS_HINT =
  '工作方式：每次动手前先用一两句简体中文说明你打算做什么、为什么；调用工具前说明目的；' +
  '工具返回后用中文简要说明结果说明了什么；最后给出结论。不要只发工具调用而不说话。';

export function onRequest(body, ctx) {
  if (!body || typeof body !== 'object') return;
  const o = ctx.options || {};
  if (!wanted(o, body, ctx)) return;

  // 用户消息注入策略：默认只对 Anthropic 协议改 messages。
  // chat/responses 只改 system——DSH 这类客户端会把注入的用户消息回显成
  // 新的用户输入，形成「指令→回显→再注入」的循环。
  const userInject = o.user_inject || 'anthropic';
  const injectUser = userInject === 'always' || (userInject === 'anthropic' && ctx.protocol === 'anthropic');

  // 开关一：中文注入（默认开）
  if (o.zh !== false) {
    const mode = o.zh_mode || o.mode || 'both';
    const sys = typeof o.system_prompt === 'string' && o.system_prompt ? o.system_prompt : SYSTEM_PROMPT;
    const usr = typeof o.user_prompt === 'string' && o.user_prompt ? o.user_prompt : USER_PROMPT;
    if (mode !== 'user') giveSystem(body, ctx, sys);
    if (mode !== 'system' && injectUser) giveUser(body, ctx, usr);
    if (mode === 'user' && !injectUser) giveSystem(body, ctx, sys); // 降级：只改 system
  }

  // 开关二：过程提示（默认关）
  if (o.process === true) {
    const hint = typeof o.process_hint === 'string' && o.process_hint ? o.process_hint : PROCESS_HINT;
    const where = o.process_in || 'system';
    if (where !== 'user') giveSystem(body, ctx, hint);
    if (where !== 'system' && injectUser) giveUser(body, ctx, hint);
    if (where === 'user' && !injectUser) giveSystem(body, ctx, hint); // 降级
  }

  // 开关三：思维链（默认 auto，不改）
  applyThinking(body, ctx, o);
  return body;
}

function wanted(o, body, ctx) {
  if (Array.isArray(o.agents) && o.agents.length && o.agents.indexOf(ctx.agent) < 0) return false;
  if (Array.isArray(o.models) && o.models.length) {
    const id = String(body.model || ctx.model || '').toLowerCase();
    const starts = [0];
    for (let i = id.indexOf('/'); i >= 0; i = id.indexOf('/', i + 1)) starts.push(i + 1);
    const hit = o.models.some(function (m) {
      if (typeof m !== 'string' || !m) return false;
      const p = m.toLowerCase();
      return starts.some(function (at) { return id.startsWith(p, at); });
    });
    if (!hit) return false;
  }
  return true;
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(function (b) { return b && typeof b.text === 'string' ? b.text : ''; }).join('\n');
}

function giveSystem(body, ctx, p) {
  switch (ctx.protocol) {
    case 'anthropic': {
      const s = body.system;
      if (typeof s === 'string') {
        if (s.indexOf(p) < 0) body.system = s ? s + '\n\n' + p : p;
      } else if (Array.isArray(s)) {
        if (textOfBlocks(s).indexOf(p) < 0) s.push({ type: 'text', text: p });
      } else {
        body.system = p;
      }
      break;
    }
    case 'chat': {
      const msgs = body.messages;
      if (!Array.isArray(msgs)) break;
      const first = msgs[0];
      if (first && (first.role === 'system' || first.role === 'developer')) {
        if (typeof first.content === 'string') {
          if (first.content.indexOf(p) < 0) first.content = first.content ? first.content + '\n\n' + p : p;
        } else if (Array.isArray(first.content)) {
          if (textOfBlocks(first.content).indexOf(p) < 0) first.content.push({ type: 'text', text: p });
        }
      } else {
        msgs.unshift({ role: 'system', content: p });
      }
      break;
    }
    case 'responses': {
      const s = body.instructions;
      if (typeof s === 'string') {
        if (s.indexOf(p) < 0) body.instructions = s ? s + '\n\n' + p : p;
      } else {
        body.instructions = p;
      }
      break;
    }
    case 'gemini': {
      const key = body.system_instruction && !body.systemInstruction ? 'system_instruction' : 'systemInstruction';
      let s = body[key];
      if (!s || !Array.isArray(s.parts)) { s = { parts: [] }; body[key] = s; }
      if (textOfBlocks(s.parts).indexOf(p) < 0) s.parts.push({ text: p });
      break;
    }
  }
}

function giveUser(body, ctx, p) {
  switch (ctx.protocol) {
    case 'anthropic': return anthropicUser(body, p);
    case 'chat': return chatUser(body, p);
    case 'responses': return responsesUser(body, p);
    case 'gemini': return geminiUser(body, p);
  }
}

function anthropicUser(body, p) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return;
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') {
    msgs.push({ role: 'user', content: [{ type: 'text', text: p }] });
    return;
  }
  const c = last.content;
  if (typeof c === 'string') {
    if (c.indexOf(p) < 0) last.content = p + '\n\n' + c;
    return;
  }
  if (!Array.isArray(c)) return;
  const hasTool = c.some(function (b) { return b && b.type === 'tool_result'; });
  if (hasTool) {
    // 工具轮次：独立一条 user 消息（实测才能影响 thinking 语言）
    msgs.push({ role: 'user', content: [{ type: 'text', text: p }] });
    return;
  }
  const first = c.filter(function (b) { return b && b.type === 'text'; })[0];
  if (first) {
    if (first.text.indexOf(p) < 0) first.text = p + '\n\n' + first.text;
  } else {
    c.push({ type: 'text', text: p });
  }
}

function chatUser(body, p) {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return;
  const last = msgs[msgs.length - 1];
  if (!last || last.role === 'tool' || last.role !== 'user') {
    msgs.push({ role: 'user', content: p });
    return;
  }
  const c = last.content;
  if (typeof c === 'string') {
    if (c.indexOf(p) < 0) last.content = p + '\n\n' + c;
    return;
  }
  if (Array.isArray(c)) {
    if (textOfBlocks(c).indexOf(p) < 0) c.unshift({ type: 'text', text: p });
  }
}

function responsesUser(body, p) {
  const input = body.input;
  if (typeof input === 'string') {
    if (input.indexOf(p) < 0) body.input = p + '\n\n' + input;
    return;
  }
  if (!Array.isArray(input) || !input.length) {
    body.input = [{ role: 'user', content: [{ type: 'input_text', text: p }] }];
    return;
  }
  const last = input[input.length - 1];
  if (!last || last.role !== 'user') {
    input.push({ role: 'user', content: [{ type: 'input_text', text: p }] });
    return;
  }
  const c = last.content;
  if (typeof c === 'string') {
    if (c.indexOf(p) < 0) last.content = p + '\n\n' + c;
    return;
  }
  if (Array.isArray(c)) {
    const hasTool = c.some(function (b) { return b && (b.type === 'function_call_output' || b.type === 'tool_result'); });
    if (hasTool) {
      input.push({ role: 'user', content: [{ type: 'input_text', text: p }] });
      return;
    }
    if (textOfBlocks(c).indexOf(p) < 0) c.unshift({ type: 'input_text', text: p });
  }
}

function geminiUser(body, p) {
  const contents = body.contents;
  if (!Array.isArray(contents) || !contents.length) return;
  const last = contents[contents.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.parts)) return;
  const hasFn = last.parts.some(function (b) { return b && b.functionResponse; });
  if (hasFn) return; // Gemini 对 functionResponse 轮次的结构较严，交给 system 注入
  if (textOfBlocks(last.parts).indexOf(p) < 0) last.parts.unshift({ text: p });
}

// 思维链开关：auto 不动；on 只在客户端没要求时打开；off 强制关。
// 实测（WorkBuddy deepseek-v4.1-flash）：chat 的 reasoning_effort "off"
// 让 reasoning_tokens 归零；anthropic 的 thinking.disabled 同样有效。
function applyThinking(body, ctx, o) {
  const t = o.thinking;
  if (t !== 'on' && t !== 'off') return; // auto 或没写：不改
  const on = t === 'on';
  const budget = Number(o.thinking_budget) > 0 ? Number(o.thinking_budget) : 2048;
  const effort = typeof o.thinking_effort === 'string' && o.thinking_effort ? o.thinking_effort : 'high';
  switch (ctx.protocol) {
    case 'anthropic': {
      const cur = body.thinking;
      if (on) {
        if (cur && cur.type === 'enabled') return; // 客户端已经开了，尊重它的预算
        body.thinking = { type: 'enabled', budget_tokens: budget };
      } else {
        body.thinking = { type: 'disabled' };
      }
      break;
    }
    case 'chat': {
      if (on) {
        if (typeof body.reasoning_effort !== 'string' || !body.reasoning_effort) body.reasoning_effort = effort;
      } else {
        body.reasoning_effort = 'off';
      }
      break;
    }
    case 'responses': {
      if (on) {
        if (!body.reasoning) body.reasoning = { effort: effort };
      } else {
        body.reasoning = { effort: 'none' };
      }
      break;
    }
    case 'gemini': {
      if (!body.generationConfig || typeof body.generationConfig !== 'object') body.generationConfig = {};
      const gc = body.generationConfig;
      if (!gc.thinkingConfig || typeof gc.thinkingConfig !== 'object') gc.thinkingConfig = {};
      gc.thinkingConfig.thinkingBudget = on ? budget : 0;
      break;
    }
  }
}
