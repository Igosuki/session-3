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

export function restore_level_index(name) {
    const level = RESTORE_LEVELS.indexOf(name);
    return level < 0 ? RESTORE_LEVELS.length - 1 : level;
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
export function save_skip_reason({ enabled, busy, restore_pending, count, prev_count }) {
    if (!enabled) return 'auto-save disabled';
    if (busy) return 'restore in progress';
    if (restore_pending) return 'login restore not yet complete';
    if (count === undefined) return null;
    if (count === 0) return 'no windows';
    if (prev_count > 0 && count < prev_count / 2) {
        return `window count fell from ${prev_count} to ${count}`;
    }
    return null;
}
