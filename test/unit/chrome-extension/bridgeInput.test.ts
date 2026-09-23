import { beforeAll, describe, expect, it } from 'vitest';

// test/unit/chrome-extension/bridgeInput.test.ts
// options 页的输入解析。
//
// 起因是一次真实的误配：端口框曾经是 `<input type="number">`，把 `ws://127.0.0.1:32110` 粘贴进去
// 时浏览器**静默删掉**非数字字符，得到 `127.00132110` → 解析成端口 127 → 扩展永远停在
// "Disconnected — retrying"，屏幕上没有任何东西解释为什么。用户看不到的错误值比被拒绝的值更糟，
// 所以这里锁定"接受人们真正会粘贴的形态，其余明确报错"。

type BridgeInput = {
    DEFAULT_PORT: number;
    extractPort: (raw: unknown) => number | null;
    extractToken: (raw: unknown) => string | null;
    parseBridgeInput: (rawPort: unknown, rawToken: unknown) =>
        | { config: { port: number; token: string } }
        | { error: string; token: string };
};

let bridgeInput: BridgeInput;

beforeAll(async () => {
    // 经典脚本，无构建步骤：它把 API 挂在 globalThis 上（见该文件末尾），这里直接读回。
    await import('../../../chrome-extension/bridge-input.js');
    bridgeInput = (globalThis as unknown as { FoliaBridgeInput: BridgeInput }).FoliaBridgeInput;
});

describe('bridge port/token input', () => {
    it('accepts a bare port', () => {
        expect(bridgeInput.extractPort('32110')).toBe(32110);
        expect(bridgeInput.extractPort('  32110 ')).toBe(32110);
    });

    it('accepts the whole address Folia shows, in every shape it is written in', () => {
        // 这四种都是设置面板里出现过或用户会写出来的形态。
        expect(bridgeInput.extractPort('ws://127.0.0.1:32110')).toBe(32110);
        expect(bridgeInput.extractPort('127.0.0.1:32110')).toBe(32110);
        expect(bridgeInput.extractPort('http://127.0.0.1:32110/external-media/health')).toBe(32110);
        expect(bridgeInput.extractPort('ws://127.0.0.1:32110/external-media/ws?token=abc')).toBe(32110);
    });

    it('returns null for an address with no port instead of guessing one', () => {
        expect(bridgeInput.extractPort('127.0.0.1')).toBeNull();
        expect(bridgeInput.extractPort('ws://127.0.0.1')).toBeNull();
        expect(bridgeInput.extractPort('')).toBeNull();
        expect(bridgeInput.extractPort(null)).toBeNull();
        expect(bridgeInput.extractPort('not a port')).toBeNull();
    });

    it('says an address is an address rather than reporting a bogus range error', () => {
        // 旧实现把 `127.00132110` 读成 127 并通过校验 —— 语法合法、语义荒谬。现在这一类输入
        // 得到的是能指出问题的措辞。
        const parsed = bridgeInput.parseBridgeInput('ws://127.0.0.1', '');
        expect('error' in parsed && parsed.error).toMatch(/address, not a port/);

        const range = bridgeInput.parseBridgeInput('70000', 'tok');
        expect('error' in range && range.error).toMatch(/between 1 and 65535/);
    });

    it('recovers the token from a pasted address so one paste fills both fields', () => {
        const parsed = bridgeInput.parseBridgeInput('ws://127.0.0.1:32110/external-media/ws?token=se%2Bcret', '');
        expect('config' in parsed && parsed.config).toEqual({ port: 32110, token: 'se+cret' });
    });

    it('requires a token, and reports the port it did manage to read', () => {
        const parsed = bridgeInput.parseBridgeInput('32110', '');
        expect('error' in parsed && parsed.error).toMatch(/Token is required/);
    });

    it('prefers the token field over anything in the port field', () => {
        const parsed = bridgeInput.parseBridgeInput('32110', 'from-field');
        expect('config' in parsed && parsed.config).toEqual({ port: 32110, token: 'from-field' });
    });
});
