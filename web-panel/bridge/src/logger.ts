const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BRIDGE_LOG_FILE_NAME, BRIDGE_LOG_HISTORY_LIMIT } = require('./constants');

import type { BridgeLogEntry, BridgeLogger, BridgeOptions, LogLevel } from './types';

type BridgeLogListener = (entry: BridgeLogEntry) => void;

const history: BridgeLogEntry[] = [];
const listeners = new Set<BridgeLogListener>();

function describeError(error: unknown) {
    return error && typeof error === 'object' && 'stack' in error
        ? String(error.stack)
        : String(error);
}

function recordLogEntry(entry: BridgeLogEntry) {
    history.push(entry);
    if (history.length > BRIDGE_LOG_HISTORY_LIMIT) {
        history.splice(0, history.length - BRIDGE_LOG_HISTORY_LIMIT);
    }

    for (const listener of listeners) {
        try {
            listener(entry);
        } catch {}
    }
}

function writeLogLine(logFile: string, level: LogLevel, message: string, error?: unknown) {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    const tag = `[wand-remote-bridge] ${message}`;
    const time = new Date().toISOString();
    const detail = error ? describeError(error) : undefined;

    // Logging runs inside Wand's own process; a failure here must never take the app down.
    try {
        console[method](tag, error || '');
    } catch {}

    try {
        fs.appendFileSync(
            logFile,
            `[${time}] [${level}] ${message}${detail ? ` :: ${detail}` : ''}\n`,
        );
    } catch {}

    recordLogEntry(detail ? { time, level, message, detail } : { time, level, message });
}

function createBridgeLogger(options: BridgeOptions = {}): BridgeLogger {
    const logFile = options.logFile || path.join(os.tmpdir(), BRIDGE_LOG_FILE_NAME);
    const log = ((level: LogLevel, message: string, error?: unknown) =>
        writeLogLine(logFile, level, message, error)) as BridgeLogger;
    log.file = logFile;
    return log;
}

function writeInstallLog(level: LogLevel, message: string, error?: unknown) {
    writeLogLine(path.join(os.tmpdir(), BRIDGE_LOG_FILE_NAME), level, message, error);
}

/** Recent bridge log lines, oldest first, so a window opened later can still show them. */
function getBridgeLogHistory(): BridgeLogEntry[] {
    return history.slice();
}

function subscribeBridgeLog(listener: BridgeLogListener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

module.exports = {
    createBridgeLogger,
    getBridgeLogHistory,
    subscribeBridgeLog,
    writeInstallLog,
};
