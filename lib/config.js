
/* lib/config.js
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

import GLib from 'gi://GLib';

import { expand_path } from './policy.js';

const DEFAULT_FILE = GLib.get_home_dir() + '/.config/session-3/session.json';

export const opt = {
    filename: DEFAULT_FILE,
    debug: 3,
    // Applications that manage their own session restore; matched
    // case-insensitively against WM class and desktop app id:
    self_managed: [
        'firefox',
        'google-chrome',
        'chromium',
        'TradingView',
        'dev.zed.Zed',
        'jetbrains-webstorm',
        'install4j-jclient-LoginFrame',
        'code',
        'Slack',
        'discord',
        'obsidian',
    ],
    settle_seconds: 20,
    auto_save: true,
    auto_save_minutes: 5,
    auto_restore: true,
    auto_restore_delay_seconds: 5,
    auto_restore_level: 'missing',
};

const readers = {
    'session-file': (s, k) => {
        const file = s.get_string(k).trim();
        opt.filename = file ? expand_path(file, GLib.get_home_dir()) : DEFAULT_FILE;
    },
    'debug-level': (s, k) => { opt.debug = s.get_int(k); },
    'self-managed': (s, k) => { opt.self_managed = s.get_strv(k); },
    'settle-seconds': (s, k) => { opt.settle_seconds = s.get_int(k); },
    'auto-save': (s, k) => { opt.auto_save = s.get_boolean(k); },
    'auto-save-minutes': (s, k) => { opt.auto_save_minutes = s.get_int(k); },
    'auto-restore': (s, k) => { opt.auto_restore = s.get_boolean(k); },
    'auto-restore-delay-seconds': (s, k) => { opt.auto_restore_delay_seconds = s.get_int(k); },
    'auto-restore-level': (s, k) => { opt.auto_restore_level = s.get_string(k); },
};

let bound = null;
let handlers = [];

export function bind_settings(settings) {
    unbind_settings();
    bound = settings;
    for (const [key, read] of Object.entries(readers)) {
        read(settings, key);
        handlers.push(settings.connect(`changed::${key}`, () => read(settings, key)));
    }
}

export function unbind_settings() {
    for (const id of handlers) bound.disconnect(id);
    handlers = [];
    bound = null;
}
