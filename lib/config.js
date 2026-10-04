
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

export const opt = {
    filename: GLib.get_home_dir() + '/.config/session-3/session.json',
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
    auto_save_minutes: 5,
    auto_restore: true,
    auto_restore_delay_seconds: 5,
};
