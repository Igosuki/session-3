/* lib/auto.js
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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { opt } from './config.js';
import { debug } from './log.js';
import { is_busy, save_session, restore_session, session_file_exists } from './actions.js';
import { restore_level_index, save_skip_reason } from './policy.js';

// The shell process outlives enable()/disable() cycles (screen lock), so login
// restore is tracked here rather than per Auto instance.
let login_restore_started = false;

export class Auto {
    constructor(settings) {
        this._settings = settings;
        this._handlers = [];
        this._save_source = 0;
        this._startup_handler = 0;
        this._restore_source = 0;
        this._restore_pending = false;
        this._prev_count = null;
    }

    start() {
        for (const key of ['auto-save', 'auto-save-minutes']) {
            this._handlers.push(this._settings.connect(`changed::${key}`, () => this._arm_save_timer()));
        }
        this._arm_save_timer();
        this._schedule_login_restore();
    }

    stop() {
        for (const id of this._handlers) this._settings.disconnect(id);
        this._handlers = [];
        this._save_source = this._remove_source(this._save_source);
        this._restore_source = this._remove_source(this._restore_source);
        if (this._startup_handler) {
            Main.layoutManager.disconnect(this._startup_handler);
            this._startup_handler = 0;
        }
    }

    _remove_source(id) {
        if (id) GLib.Source.remove(id);
        return 0;
    }

    _arm_save_timer() {
        this._save_source = this._remove_source(this._save_source);
        this._prev_count = null;
        if (!opt.auto_save) return;

        this._save_source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, opt.auto_save_minutes * 60, () => {
            this._save_tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _save_tick() {
        const state = () => ({
            enabled: opt.auto_save,
            busy: is_busy(),
            restore_pending: this._restore_pending,
        });

        if (this._restore_pending && login_restore_started && !is_busy()) this._restore_pending = false;

        try {
            const early = save_skip_reason(state());
            if (early) {
                debug(2, `Auto-save skipped: ${early}`);
                return;
            }

            save_session({
                quiet: true,
                skip_if: count => {
                    const reason = save_skip_reason({ ...state(), count, prev_count: this._prev_count });
                    this._prev_count = count;
                    return reason;
                },
            });
        } catch (error) {
            debug(1, `Auto-save failed: ${error.message}`);
        }
    }

    _schedule_login_restore() {
        if (!Main.layoutManager._startingUp || login_restore_started || !opt.auto_restore) {
            this._restore_pending = false;
            return;
        }

        this._restore_pending = true;
        this._startup_handler = Main.layoutManager.connect('startup-complete', () => {
            Main.layoutManager.disconnect(this._startup_handler);
            this._startup_handler = 0;
            this._restore_source = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, opt.auto_restore_delay_seconds, () => {
                    this._restore_source = 0;
                    this._login_restore();
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    _login_restore() {
        login_restore_started = true;
        if (!session_file_exists()) {
            debug(2, `Auto-restore: no session file at ${opt.filename}`);
            this._restore_pending = false;
            return;
        }

        try {
            debug(2, `Auto-restore (${opt.auto_restore_level}).`);
            restore_session(restore_level_index(opt.auto_restore_level), {
                on_done: () => { this._restore_pending = false; },
            });
        } catch (error) {
            debug(1, `Auto-restore failed: ${error.message}`);
            this._restore_pending = false;
        }
    }
}
