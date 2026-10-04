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
import { debug } from './log.js';
import { Desktop } from './desktop.js';
import { Session } from './session.js';
import { backup_copies } from './policy.js';

// Upper bound so that a restore which never reports completion cannot pause auto-save forever.
const MAX_BUSY_SECONDS = 600;

let busy = false;
let session = null;
let settle_source = 0;
let failsafe_source = 0;

export function is_busy() {
    return busy;
}

export function session_file_exists() {
    return GLib.file_test(opt.filename, GLib.FileTest.EXISTS);
}

function clear_source(id) {
    if (id) GLib.Source.remove(id);
    return 0;
}

function end_busy() {
    settle_source = clear_source(settle_source);
    failsafe_source = clear_source(failsafe_source);
    busy = false;
}

function rotate_backups() {
    if (!session_file_exists()) return;
    for (const { from, to } of backup_copies(opt.filename)) {
        const source = Gio.File.new_for_path(from);
        if (!source.query_exists(null)) continue;
        source.copy(Gio.File.new_for_path(to), Gio.FileCopyFlags.OVERWRITE, null, null);
    }
}

// skip_if receives the normal-window count and returns a reason string to skip the save.
export function save_session({ quiet = false, skip_if = null } = {}) {
    const desktop = new Desktop();
    const reason = skip_if?.(Object.keys(desktop.windows).length);
    if (reason) {
        debug(2, `Save skipped: ${reason}`);
        return false;
    }

    GLib.mkdir_with_parents(GLib.path_get_dirname(opt.filename), 0o755);
    rotate_backups();
    return desktop.save(quiet);
}

// level: 0 existing, 1 matching, 2 missing. on_done runs when window properties have been restored.
export function restore_session(level, { on_done = null } = {}) {
    destroy_session();
    busy = true;
    failsafe_source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_BUSY_SECONDS, () => {
        debug(1, 'Restore did not report completion; resuming auto-save.');
        end_busy();
        failsafe_source = 0;
        return GLib.SOURCE_REMOVE;
    });

    try {
        const current = new Session();
        session = current;
        const reports_settled = 'on_settled' in current;
        if (reports_settled) current.on_settled = end_busy;
        current.on_finished = finished => {
            try {
                on_done?.(finished);
            } finally {
                if (!reports_settled && session === current) {
                    settle_source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, opt.settle_seconds, () => {
                        settle_source = 0;
                        end_busy();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
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
}

function destroy_session() {
    const old = session;
    session = null;
    settle_source = clear_source(settle_source);
    if (old) old.destroy?.();
}

export function shutdown() {
    destroy_session();
    end_busy();
}
