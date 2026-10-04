
/* lib/log.js
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

const levels = {
    0: 'ERROR',
    1: 'WARN',
    2: 'INFO',
    3: 'DETAIL',
    4: 'DEBUG',
};

let logger = {
    level: () => 3,
    notify: () => {},
    gettext: s => s,
};

// level is a function so that changes to the configured level apply immediately:
export function setLogger({ level, notify, gettext }) {
    logger = { level, notify, gettext };
}

export function _(str) {
    return logger.gettext(str);
}

export function notify(title, body) {
    logger.notify(title, body, null);
}

export function debug(level, entry) {
    if (level === 0) {
        if (typeof entry === 'string') entry = new Error(entry);
        log(`${levels[level]}: ${entry.message}\n${entry.stack}`);
        notify(_('Runtime error'), _(entry.message));
        throw entry;
    } else if (level <= logger.level()) {
        log(`${levels[level]}: ${entry}`);
    }
}
