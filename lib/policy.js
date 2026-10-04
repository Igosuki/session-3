/* lib/policy.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const BACKUP_GENERATIONS = 3;

export const RESTORE_LEVELS = ['existing', 'matching', 'missing'];

export const HIGH_WATER_CONFIRMATIONS = 3;

export const BACKUP_MIN_AGE_SECONDS = 3600;

export function restore_level_index(name) {
    const level = RESTORE_LEVELS.indexOf(name);
    if (level < 0) throw new Error(`Unknown restore level: ${name}`);
    return level;
}

export function expand_path(path, home) {
    if (path === '~') return home;
    if (path.startsWith('~/')) return home + path.slice(1);
    return path;
}

// Oldest first, so that each copy overwrites a slot that has already been
// copied onward.
export function backup_copies(file, generations = BACKUP_GENERATIONS) {
    const copies = [];
    for (let n = generations; n >= 1; n--) {
        copies.push({ from: n === 1 ? file : `${file}.${n - 1}`, to: `${file}.${n}` });
    }
    return copies;
}

// Returns a reason string when the timed save must be skipped, else null.
// `count` is omitted for the checks that do not need a window snapshot.
export function save_skip_reason({ enabled, busy, restore_pending, paused = null, count, prev_count }) {
    if (!enabled) return 'auto-save disabled';
    if (paused) return `auto-save paused: ${paused}`;
    if (busy) return 'restore in progress';
    if (restore_pending) return 'login restore not yet complete';
    if (count === undefined) return null;
    if (count === 0) return 'no windows';
    if (prev_count > 0 && count < prev_count / 2) {
        return `window count fell from ${prev_count} to ${count}`;
    }
    return null;
}

export function new_high_water(high = 0) {
    return { high, low: 0, streak: 0 };
}

// The mark rises immediately but only drops once HIGH_WATER_CONFIRMATIONS consecutive
// ticks report the same lower count, so one bad snapshot never lowers the guard.
export function track_high_water(state, count) {
    if (count <= 0) return state;
    if (count >= state.high) return new_high_water(count);
    const streak = count === state.low ? state.streak + 1 : 1;
    if (streak >= HIGH_WATER_CONFIRMATIONS) return new_high_water(count);
    return { high: state.high, low: count, streak };
}

// age_seconds is null when the newest backup does not exist.
export function should_rotate({ quiet, age_seconds }) {
    if (!quiet || age_seconds === null) return true;
    return age_seconds > BACKUP_MIN_AGE_SECONDS;
}

export function count_saved_windows(content) {
    if (content === null || typeof content !== 'object' || Array.isArray(content)) return 0;
    return Object.keys(content).filter(key => key !== 'opt').length;
}

export function restore_summary({ total, restored, not_found = 0, failed = 0, unlaunchable = 0 }) {
    const parts = [`Restored ${restored} of ${total} windows`];
    if (not_found) parts.push(`${not_found} not found`);
    if (failed) parts.push(`${failed} failed to launch`);
    if (unlaunchable) parts.push(`${unlaunchable} can't launch`);
    return parts.join('; ');
}
