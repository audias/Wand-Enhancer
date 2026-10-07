const fs = require('node:fs');
const path = require('node:path');

const { PATCH_LOG_FILE_NAME } = require('../constants');
const { getBridgeLogHistory, subscribeBridgeLog } = require('../logger');

import type { BridgeLogEntry, BridgeOptions, ElectronPort, WebContentsPort } from '../types';

type ConsoleCall = [method: string, ...args: unknown[]];

declare global {
    var __wandRemoteBridgeDevToolsLogInstalled: boolean | undefined;
}

const PAGE_REPLAYED_FLAG = '__wandEnhancerLogReplayed';

function patchLogMethod(line: string) {
    return line.includes('[ERROR]') ? 'error' : line.includes('[WARN]') ? 'warn' : 'info';
}

function bridgeLineCall(entry: BridgeLogEntry): ConsoleCall {
    const text = `[wand-remote-bridge] ${entry.time} ${entry.message}`;
    return entry.detail ? [entry.level, text, entry.detail] : [entry.level, text];
}

/** Console calls run in the page; a missing method or a closed console is never fatal there. */
function buildConsoleScript(calls: ConsoleCall[], onceFlag?: string) {
    const guard = onceFlag
        ? `if (globalThis[${JSON.stringify(onceFlag)}]) return; globalThis[${JSON.stringify(onceFlag)}] = true;`
        : '';
    return `(() => { ${guard} for (const [method, ...args] of ${JSON.stringify(calls)}) { try { console[method](...args); } catch (_) {} } })();`;
}

function buildLogReplayScript(patchLog: string | null, history: BridgeLogEntry[]) {
    const calls: ConsoleCall[] = [];
    if (patchLog === null) {
        calls.push(['info', '[wand-enhancer] No patch log found next to app.asar.']);
    } else {
        const lines = patchLog.split(/\r?\n/).filter((line) => line.trim() !== '');
        calls.push(['groupCollapsed', `[wand-enhancer] Patch log (${lines.length} lines)`]);
        for (const line of lines) {
            calls.push([patchLogMethod(line), line]);
        }
        calls.push(['groupEnd']);
    }

    calls.push(['groupCollapsed', `[wand-remote-bridge] Log so far (${history.length} entries)`]);
    calls.push(...history.map(bridgeLineCall));
    calls.push(['groupEnd']);
    return buildConsoleScript(calls, PAGE_REPLAYED_FLAG);
}

function buildLogLineScript(entry: BridgeLogEntry) {
    return buildConsoleScript([bridgeLineCall(entry)]);
}

function readPatchLog(file: string | undefined): string | null {
    if (!file) {
        return null;
    }

    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function runInWindow(contents: WebContentsPort, script: string) {
    if (contents.isDestroyed()) {
        return false;
    }

    // Never report this failure through the bridge logger: it would be forwarded here again.
    contents.executeJavaScript(script).catch(() => undefined);
    return true;
}

/**
 * Mirrors diagnostics into every Wand window's DevTools console: the patcher's own log of
 * the run that produced this install, the bridge log so far, then each new bridge line.
 */
function installDevToolsLog(
    electron: ElectronPort,
    options: BridgeOptions & { patchLogFile?: string } = {},
) {
    if (globalThis.__wandRemoteBridgeDevToolsLogInstalled) {
        return;
    }

    globalThis.__wandRemoteBridgeDevToolsLogInstalled = true;
    const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
    const patchLogFile =
        options.patchLogFile ||
        (resourcesPath ? path.join(resourcesPath, PATCH_LOG_FILE_NAME) : undefined);
    const replayedWindows = new Set<WebContentsPort>();

    subscribeBridgeLog((entry: BridgeLogEntry) => {
        const script = buildLogLineScript(entry);
        for (const contents of replayedWindows) {
            if (!runInWindow(contents, script)) {
                replayedWindows.delete(contents);
            }
        }
    });

    electron.app.on('web-contents-created', (_event: unknown, contents: WebContentsPort) => {
        const replay = () => {
            // Marked before the replay runs so a line logged meanwhile follows it, not precedes it.
            replayedWindows.add(contents);
            if (
                !runInWindow(
                    contents,
                    buildLogReplayScript(readPatchLog(patchLogFile), getBridgeLogHistory()),
                )
            ) {
                replayedWindows.delete(contents);
            }
        };

        contents.on('dom-ready', replay);
        contents.on('did-finish-load', replay);
        contents.once?.('destroyed', () => replayedWindows.delete(contents));
    });
}

module.exports = {
    buildLogLineScript,
    buildLogReplayScript,
    installDevToolsLog,
};
