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
import { debug, notify, _ } from './log.js';
import {
    is_busy, save_session, restore_session, session_file_exists,
    pause_autosave, autosave_pause_reason, seed_high_water, track_window_count,
} from './actions.js';
import { restore_level_index, save_skip_reason } from './policy.js';

const FAILURE_NOTIFY_THRESHOLD = 3;

// The shell process outlives enable()/disable() cycles (screen lock), so login
// restore is tracked here rather than per Auto instance.
let login_restore_started = false;
let login_restore_pending = false;
let login_restore_due = 0;

export class Auto {
    constructor(settings) {
        this._settings = settings;
        this._handlers = [];
        this._save_source = 0;
        this._startup_handler = 0;
        this._restore_source = 0;
        this._restore_pending = false;
        this._failures = 0;
    }

    start() {
        seed_high_water();
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
            paused: autosave_pause_reason(),
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
                skip_if: count => save_skip_reason({ ...state(), count, prev_count: track_window_count(count) }),
            });
            this._failures = 0;
        } catch (error) {
            this._failures++;
            debug(1, `Auto-save to ${opt.filename} failed (${this._failures} in a row): ${error.stack ?? error}`);
            if (this._failures === FAILURE_NOTIFY_THRESHOLD) {
                notify(_('Auto-save failing'), _(`Could not save the session to ${opt.filename}: ${error.message ?? error}`));
            }
        }
    }

    _schedule_login_restore() {
        if (login_restore_started) {
            debug(2, 'Login restore skipped: already ran in this shell session');
            this._restore_pending = false;
            return;
        }

        if (!login_restore_pending) {
            const starting_up = Main.layoutManager._startingUp;
            if (starting_up === undefined) {
                debug(1, 'Login restore skipped: layoutManager._startingUp is unavailable on this shell');
            } else if (!starting_up) {
                debug(2, 'Login restore skipped: shell is not starting up');
            } else if (!opt.auto_restore) {
                debug(2, 'Login restore skipped: auto-restore disabled');
            } else {
                login_restore_pending = true;
            }
            if (!login_restore_pending) {
                this._restore_pending = false;
                return;
            }
        }

        this._restore_pending = true;
        if (Main.layoutManager._startingUp) {
            this._startup_handler = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startup_handler);
                this._startup_handler = 0;
                this._arm_login_restore();
            });
        } else {
            this._arm_login_restore();
        }
    }

    _arm_login_restore() {
        const now = GLib.get_monotonic_time();
        if (!login_restore_due) login_restore_due = now + opt.auto_restore_delay_seconds * 1000000;
        const remaining = Math.max(0, Math.ceil((login_restore_due - now) / 1000000));

        this._restore_source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, remaining, () => {
            this._restore_source = 0;
            login_restore_pending = false;
            login_restore_due = 0;
            this._login_restore();
            return GLib.SOURCE_REMOVE;
        });
    }

    _login_restore() {
        login_restore_started = true;
        if (!opt.auto_restore) {
            debug(2, 'Login restore skipped: auto-restore disabled before it ran');
            this._restore_pending = false;
            return;
        }
        if (!session_file_exists()) {
            debug(2, `Auto-restore: no session file at ${opt.filename}`);
            this._restore_pending = false;
            return;
        }

        try {
            debug(2, `Auto-restore (${opt.auto_restore_level}).`);
            const started = restore_session(restore_level_index(opt.auto_restore_level), {
                login: true,
                on_done: () => { this._restore_pending = false; },
                on_fail: error => this._login_restore_failed(error),
            });
            if (!started) this._restore_pending = false;
        } catch (error) {
            debug(1, `Auto-restore failed: ${error.stack ?? error}`);
            this._login_restore_failed(error);
        }
    }

    _login_restore_failed(error) {
        const reason = error.message ?? String(error);
        pause_autosave(`login restore failed: ${reason}`);
        notify(_('Session'), _(`Auto-restore failed: ${reason}; auto-save paused until you save or restore manually`));
        this._restore_pending = false;
    }
}
