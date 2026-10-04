/* lib/actions.js
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
import Gio  from 'gi://Gio';

import { opt } from './config.js';
import { debug, notify, _ } from './log.js';
import { Desktop } from './desktop.js';
import { Session } from './session.js';
import {
    backup_copies, count_saved_windows, new_high_water, should_rotate, track_high_water,
} from './policy.js';

// Upper bound so that a restore which never reports completion cannot pause auto-save forever.
const MAX_BUSY_SECONDS = 600;

let busy = false;
let session = null;
let failsafe_source = 0;
let high_water = new_high_water();
let pause_reason = null;

export function is_busy() {
    return busy;
}

export function session_file_exists() {
    return GLib.file_test(opt.filename, GLib.FileTest.EXISTS);
}

export function pause_autosave(reason) {
    pause_reason = reason;
}

export function autosave_pause_reason() {
    return pause_reason;
}

export function seed_high_water() {
    let count = 0;
    try {
        if (session_file_exists()) {
            const bytes = GLib.file_get_contents(opt.filename)[1];
            count = count_saved_windows(JSON.parse(new TextDecoder().decode(bytes)));
        }
    } catch (error) {
        debug(1, `Cannot read window count from ${opt.filename}: ${error.message}`);
    }
    high_water = new_high_water(count);
}

// Records an auto-save tick and returns the mark the count is judged against.
export function track_window_count(count) {
    high_water = track_high_water(high_water, count);
    return high_water.high;
}

function clear_source(id) {
    if (id) GLib.Source.remove(id);
    return 0;
}

function end_busy() {
    failsafe_source = clear_source(failsafe_source);
    busy = false;
}

function backup_age_seconds(path) {
    const file = Gio.File.new_for_path(`${path}.1`);
    if (!file.query_exists(null)) return null;
    const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    return GLib.get_real_time() / 1e6 - info.get_attribute_uint64('time::modified');
}

function rotate_backups(quiet) {
    if (!session_file_exists()) return;
    if (!should_rotate({ quiet, age_seconds: backup_age_seconds(opt.filename) })) return;
    for (const { from, to } of backup_copies(opt.filename)) {
        const source = Gio.File.new_for_path(from);
        if (!source.query_exists(null)) continue;
        source.copy(Gio.File.new_for_path(to), Gio.FileCopyFlags.OVERWRITE, null, null);
    }
}

// skip_if receives the normal-window count and returns a reason string to skip the save.
export function save_session({ quiet = false, skip_if = null } = {}) {
    const desktop = new Desktop();
    const count = Object.keys(desktop.windows).length;
    const reason = skip_if?.(count);
    if (reason) {
        debug(2, `Save skipped: ${reason}`);
        return false;
    }
    if (!quiet && count === 0) {
        notify(_('Session not saved'), _('No windows to save'));
        return false;
    }

    GLib.mkdir_with_parents(GLib.path_get_dirname(opt.filename), 0o755);
    try {
        rotate_backups(quiet);
    } catch (error) {
        debug(1, `Backup rotation failed for ${opt.filename}: ${error.stack ?? error}`);
    }
    desktop.save(quiet);

    if (!quiet) {
        high_water = new_high_water(count);
        pause_reason = null;
    }
    return true;
}

// level: 0 existing, 1 matching, 2 missing. on_done runs when window properties have been restored
// or the restore failed (with null). on_fail replaces the failure notification.
// login restores must not clear the auto-save pause. Returns false when there was nothing to restore.
export function restore_session(level, { on_done = null, on_fail = null, login = false } = {}) {
    if (!session_file_exists()) {
        notify(_('Session not restored'), _(`No saved session at ${opt.filename}`));
        return false;
    }

    destroy_session();
    failsafe_source = clear_source(failsafe_source);
    busy = true;
    failsafe_source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_BUSY_SECONDS, () => {
        failsafe_source = 0;
        debug(1, 'Restore did not report completion; resuming auto-save.');
        destroy_session();
        end_busy();
        return GLib.SOURCE_REMOVE;
    });

    let current = null;
    const fail = error => {
        if (session !== current) return;
        debug(1, `Restore failed: ${error.stack ?? error}`);
        destroy_session();
        end_busy();
        if (on_fail) {
            on_fail(error);
        } else {
            notify(_('Restore failed'), String(error.message ?? error));
        }
        on_done?.(null);
    };

    try {
        current = new Session({ level });
        if (Object.keys(current.restore).length === 0) {
            current.destroy();
            end_busy();
            notify(_('Session not restored'), _(`No saved session at ${opt.filename}`));
            return false;
        }

        session = current;
        current.on_error = fail;
        current.on_settled = end_busy;
        current.on_finished = finished => {
            if (!login) pause_reason = null;
            on_done?.(finished);
        };

        current.match_by_id();
        if (level > 0) current.match_by_properties();
        if (level > 1) current.restore_missing();
        if (level < 2) current.restore_properties();
    } catch (error) {
        destroy_session();
        end_busy();
        throw error;
    }
    return true;
}

function destroy_session() {
    const old = session;
    session = null;
    old?.destroy();
}

export function shutdown() {
    destroy_session();
    end_busy();
}
