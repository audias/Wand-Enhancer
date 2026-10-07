// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

// Logger and devtools-log must share one module instance, as they do in bridge.cjs.
function loadModules() {
    const bundled = buildSync({
        stdin: {
            contents:
                "module.exports = { ...require('./logger'), ...require('./wand/devtools-log') };",
            resolveDir: import.meta.dirname,
            loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
    }).outputFiles[0].text;
    return new Function('module', 'require', `${bundled};return module.exports;`)(
        { exports: {} },
        createRequire(import.meta.url),
    );
}

type ConsoleCall = [string, ...unknown[]];

function runInPage(script: string, page: Record<string, unknown> = {}) {
    const calls: ConsoleCall[] = [];
    const fakeConsole = Object.fromEntries(
        ['info', 'warn', 'error', 'debug', 'groupCollapsed', 'groupEnd'].map((method) => [
            method,
            (...args: unknown[]) => calls.push([method, ...args]),
        ]),
    );
    new Function('console', 'globalThis', script)(fakeConsole, page);
    return calls;
}

function tempLogFile(contents: string) {
    const file = join(mkdtempSync(join(tmpdir(), 'wand-devtools-log-')), 'patch.log');
    writeFileSync(file, contents);
    return file;
}

function fakeElectron() {
    let onCreated: ((event: unknown, contents: unknown) => void) | undefined;
    return {
        electron: {
            app: {
                on: (_event: string, listener: typeof onCreated) => {
                    onCreated = listener;
                },
            },
            ipcMain: { handle: () => undefined },
        },
        createContents() {
            const listeners: Record<string, () => void> = {};
            const scripts: string[] = [];
            const contents = {
                destroyed: false,
                isDestroyed: () => contents.destroyed,
                send: () => undefined,
                executeJavaScript: (code: string) => {
                    scripts.push(code);
                    return Promise.resolve();
                },
                on: (event: string, listener: () => void) => {
                    listeners[event] = listener;
                },
            };
            onCreated?.({}, contents);
            return { contents, listeners, scripts };
        },
    };
}

describe('bridge log history', () => {
    it('keeps recent entries and notifies subscribers until they unsubscribe', () => {
        const { createBridgeLogger, getBridgeLogHistory, subscribeBridgeLog } = loadModules();
        const log = createBridgeLogger({ logFile: join(tmpdir(), 'wand-devtools-log-test.log') });
        const seen: unknown[] = [];
        const unsubscribe = subscribeBridgeLog((entry: unknown) => seen.push(entry));

        log('warn', 'Port busy.', new Error('EADDRINUSE'));
        unsubscribe();
        log('info', 'Listening.');

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ level: 'warn', message: 'Port busy.' });
        expect((seen[0] as { detail: string }).detail).toContain('EADDRINUSE');
        expect(getBridgeLogHistory().map((entry: { message: string }) => entry.message)).toEqual([
            'Port busy.',
            'Listening.',
        ]);
    });

    it('drops the oldest entries past the history limit', () => {
        const { createBridgeLogger, getBridgeLogHistory } = loadModules();
        const log = createBridgeLogger({ logFile: join(tmpdir(), 'wand-devtools-log-test.log') });

        for (let index = 0; index < 205; index++) {
            log('info', `line ${index}`);
        }

        const history = getBridgeLogHistory();
        expect(history).toHaveLength(200);
        expect(history[0].message).toBe('line 5');
    });
});

describe('devtools log scripts', () => {
    it('replays the patch log and bridge history once per page with matching levels', () => {
        const { buildLogReplayScript } = loadModules();
        const script = buildLogReplayScript(
            '10:00:00.000 [INFO] [ENHANCER] Extracting app.asar...\r\n' +
                '10:00:01.000 [WARN] [ENHANCER] No auxiliary service found; skipping check.\n' +
                '10:00:02.000 [ERROR] [ENHANCER] Said "no"\n',
            [{ time: 't', level: 'debug', message: 'Quote " and\nnewline', detail: 'stack' }],
        );
        const page = {};

        const first = runInPage(script, page);
        const second = runInPage(script, page);

        expect(second).toEqual([]);
        expect(first).toEqual([
            ['groupCollapsed', '[wand-enhancer] Patch log (3 lines)'],
            ['info', '10:00:00.000 [INFO] [ENHANCER] Extracting app.asar...'],
            ['warn', '10:00:01.000 [WARN] [ENHANCER] No auxiliary service found; skipping check.'],
            ['error', '10:00:02.000 [ERROR] [ENHANCER] Said "no"'],
            ['groupEnd'],
            ['groupCollapsed', '[wand-remote-bridge] Log so far (1 entries)'],
            ['debug', '[wand-remote-bridge] t Quote " and\nnewline', 'stack'],
            ['groupEnd'],
        ]);
    });

    it('says so when no patch log was found', () => {
        const { buildLogReplayScript } = loadModules();

        expect(runInPage(buildLogReplayScript(null, []))).toEqual([
            ['info', '[wand-enhancer] No patch log found next to app.asar.'],
            ['groupCollapsed', '[wand-remote-bridge] Log so far (0 entries)'],
            ['groupEnd'],
        ]);
    });

    it('prints a live bridge line with its level', () => {
        const { buildLogLineScript } = loadModules();

        expect(
            runInPage(buildLogLineScript({ time: 't', level: 'error', message: 'Boom' })),
        ).toEqual([['error', '[wand-remote-bridge] t Boom']]);
    });
});

describe('installDevToolsLog', () => {
    it('replays on load and forwards later bridge lines only to live replayed windows', () => {
        const { createBridgeLogger, installDevToolsLog } = loadModules();
        const log = createBridgeLogger({ logFile: join(tmpdir(), 'wand-devtools-log-test.log') });
        const { electron, createContents } = fakeElectron();
        installDevToolsLog(electron, {
            patchLogFile: tempLogFile('10:00:00.000 [INFO] [ENHANCER] Done!\n'),
        });

        log('info', 'Before window.');
        const open = createContents();
        const closed = createContents();
        log('info', 'Before load.');
        open.listeners['dom-ready']();
        closed.listeners['dom-ready']();
        closed.contents.destroyed = true;
        log('warn', 'After load.');

        expect(open.scripts).toHaveLength(2);
        const replay = runInPage(open.scripts[0]);
        expect(replay).toContainEqual(['info', '10:00:00.000 [INFO] [ENHANCER] Done!']);
        expect(replay.map((call) => call[1])).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Before window.'),
                expect.stringContaining('Before load.'),
            ]),
        );
        expect(runInPage(open.scripts[1])).toEqual([
            ['warn', expect.stringContaining('After load.')],
        ]);
        expect(closed.scripts).toHaveLength(1);
    });
});
