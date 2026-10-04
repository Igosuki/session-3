
/* lib/session.js
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

import Meta    from 'gi://Meta';
import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';

import { opt } from './config.js';
import { debug, notify, _ } from './log.js';
import { levenshtein, hungarian_match } from './match.js';
import { Desktop, normal } from './desktop.js';

// A Session consists of 2 Desktops: A source (current) and a target (restore)
export class Session {
    constructor() {
        this.restore = new Desktop('restore').windows;
        this.current = new Desktop('current').windows;

        this.stat = { launches: {}, events: {} };
    }

    match_by_id() {
        debug(3, 'Matching by ID...');

        for (let restore of Object.values(this.restore)) {
            restore.match = null;

            let current = this.current[restore.id];
            if (current && restore.class   === current.class &&
                           restore.pid     === current.pid   &&
                           restore.command === current.command) {
                debug(3, `Window exists: ${restore.class} (${restore.id}) pid=${restore.pid}`);
                restore.match = current.id;
                current.match = true;
            }
        }
    }

    match_by_properties() {
        debug(3, 'Matching by properties...');

        // First, score each potential restore<->current match:
        let scores = {};
        for (let restore of Object.values(this.restore)) {
            if (restore.match) continue;
            restore._match = null;

            for (let current of Object.values(this.current)) {
                if (current.match) continue;

                // Potential matches must have the same class:
                if (restore.class !== current.class) continue;
                // and at least 1 of title, command, or pid match:
                let score = 0;
                score += Math.floor(levenshtein(restore.title, current.title) * 10);
                if (restore.pid       === current.pid      ) score += 6;
                if (restore.command   === current.command  ) score += 6;
                if (restore.workspace === current.workspace) score += 2;
                if (restore.geometry  === current.geometry ) score += 1;

                if (score > 5) {
                    scores[restore.class] = scores[restore.class] || {};
                    scores[restore.class][restore.id] = scores[restore.class][restore.id] || {};
                    scores[restore.class][restore.id][current.id] = score;
                }
            }
        }
        debug(4, `scores = ${JSON.stringify(scores, null, 2)}`);

        // Next, find the best overall restore<->current match set (map):
        for (let group of Object.keys(scores)) {
            debug(3, `Group ${group} (${Object.keys(scores[group]).length} windows)...`);

            let [score, map] = hungarian_match ( scores[group] );
            debug(3, `Best match score = ${score}`);

            // Finally, record the resulting set (map):
            for (let id of Object.keys(map)) {
                if (/^NULL#\d+$/.test(map[id])) continue;

                let restore = this.restore[id];
                let current = this.current[map[id]];
                debug(3, `Window matches: ${restore.class} (${restore.id})`
                       + ` = ${current.class} (${current.id}) pid=${current.pid}`
                       + ` score=${scores[group][restore.id][current.id]}`);
                // Mark as tentative match:
                restore._match = current.id;
            }
        }
    }

    restore_missing() {
        debug(3, `Restoring missing windows...`);

        for (let restore of Object.values(this.restore)) {
            if (!this.stat.launches[restore.group]) {
                this.stat.launches[restore.group] = {
                    id: restore.group,
                    comm: restore.comm,
                    class: restore.class,
                    matched: [],
                    remaining: [],
                    _matched: 0,
                };
            }
            if ( restore.match ) {
                this.stat.launches[restore.group].matched.push(restore);
            } else {
                this.stat.launches[restore.group].remaining.push(restore);
            }
        }

        // The launch processing loop is event-driven:
        this.stat.created = global.display.connect('window-created', (display, window) => {
            debug(4, `Window created`);
            let shown = window.connect('shown', () => {
                try {
                    window.disconnect(shown); // Only handle once
                    delete this.stat.events[shown];
                    if (!this.stat.created) return; // Block obsolete events already in progress
                    if (!normal(window)) return;
                    let id = window.get_stable_sequence();
                    if (this.current[id]) return; // Window already processed before shown...
                    this.current = new Desktop('current').windows;
                    window = this.current[id];
                    debug(3, `Window shown: ${window.class} (${window.id}) pid=${window.pid}`);
                    this.match_by_properties();
                    this._process_launches();
                } catch(error) {
                    debug(0, error);
                }
            });
            this.stat.events[shown] = window;
        });

        this._process_launches();
    }

    _process_launches() {
        let wait = 0;
        debug(4, `launches = ${JSON.stringify(this.stat.launches, (key, value) => /^(?:matched|remaining)$/.test(key) ? value.map(restore => restore.id) : value, 2)}`);
        for (let launch of Object.values(this.stat.launches)) {
            // Count current windows matched:
            let _matched = launch.remaining.filter(restore => restore._match).length;

            if (!launch.remaining.length) {
                launch.pid = '-'; // No launch needed
                delete this.stat.launches[launch.id];
            } else if ( launch.MSPW && _matched < launch.remaining.length ) { // Multiple single-pid windows
                if ( _matched <= launch._matched ) {
                    debug(3, `Launches pending: ${launch.class} (${launch.pid})`
                           + `x${launch.remaining.length - _matched} -> waiting`);
                    wait += launch.remaining.length - _matched;
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> waiting`);
                    wait += launch.remaining.length - _matched;
                }
            } else if ( _matched <= launch._matched ) { // No new matches
                if (!launch.pid) {
                    // Handled later
                } else if ( launch.pid !== '-' ) {
                    debug(3, `Launch pending: ${launch.class} (${launch.pid}) -> waiting`);
                    wait++;
                }
            } else if ( _matched < launch.remaining.length ) { // Some new matches
                if (!launch.pid) {
                    // Handled later
                } else if (launch.pid !== '-') {
                    if (opt.self_managed.some(app => app === launch.class)) { // Only launch once per self_managed application
                        debug(3, `Launch self-managed: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> give up`);
                        launch.pid = '-';
                    } else {
                        debug(3, `Launch insufficient: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> try again`);
                        launch.pid = null;
                    }
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> gave up`);
                }
            } else { // All remaining windows matched
                if (!launch.pid) {
                    launch.pid = '-'; // No launch needed
                } else if (launch.pid !== '-') {
                    debug(3, `Launch successful: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                } else {
                    debug(3, `All windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                }

                for (let restore of launch.remaining) {
                    restore.match = restore._match;
                }
                delete this.stat.launches[launch.id];
            }

            if (!launch.pid) {
                // Multiple single-pid windows (MSPW): Many applications manage
                // multiple windows using a single process. Thus, if a launched
                // process died while creating a single window that shares its
                // pid with all other windows of its class, then it's probably
                // safe to launch all the remaining windows.
                if ( launch.died && _matched == launch._matched+1 && launch.matched.length + _matched > 1 ) {
                    let pid = null;
                    for (let restore of [...launch.matched, ...launch.remaining]) {
                        let id = restore.match || restore._match;
                        if (!id) continue;
                        if (pid === null) {
                            pid = this.current[id].pid;
                        } else if (pid !== this.current[id].pid) {
                            pid = '-';
                            break;
                        }
                    }
                    if ( pid !== '-' ) {
                        launch.pid = pid;
                        launch.MSPW = true;
                        debug(4, `Multiple single-pid windows: ${launch.class} (${launch.pid})`);
                    }
                }
                delete launch.died;

                for (let i = 1; i <= (!launch.MSPW ? 1 : launch.remaining.length - _matched); i++) {
                    let pid = null;
                    try {
                        pid = GLib.spawn_async(
                            null,
                            launch.comm,
                            null,
                            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                            null
                        )[1];
                    } catch (e) {
                        debug(1, `Launch failed: ${launch.class} ${e.message}`);
                        launch.pid = '-';
                        delete this.stat.launches[launch.id]; // Launch done
                        break;
                    }
                    if ( !launch.MSPW ) launch.pid = pid;

                    let died = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                        try{
                            delete this.stat.events[died];
                            // Processes that die with status = 0 are probably fine:
                            debug(4, `Process died: ${launch.class} (${pid})`);
                            if (status) {
                                debug(3, `Launch died: ${launch.class} (${launch.pid})`
                                       + ` exit = ${(status >> 8) & 0xff}; signal = ${status & 0x7f} -> give up`);
                                launch.pid = '-';
                            }
                            launch.died = true;
                        } catch(error) {
                            debug(0, error);
                        }
                    });
                    this.stat.events[died] = null;

                    wait++;
                }

                if ( launch.pid !== '-' ) {
                    if ( !launch.MSPW ) {
                        debug(2, `Launched window: ${launch.class} (${launch.pid})`);
                    } else {
                        debug(2, `Launched windows: ${launch.class} (${launch.pid})`
                               + `x${launch.remaining.length - _matched}`);
                    }

                    if (!launch.launched) { // First launch attempt
                        for (let restore of launch.remaining) {
                            restore.pid = launch.pid; // Helps matching
                        }
                        launch.launched = true;
                    }
                }
            }

            if (_matched > launch._matched) launch._matched = _matched;
        }

        debug(3, `${wait} pending launches.`);
        if (wait) {
            let load = Gio.File.new_for_path('/proc/loadavg').load_contents(null)[1];
            load = parseFloat(new TextDecoder().decode(load).split(' ')[0]) || 1.0;
            wait = Math.round(5 + (Math.log(wait)/Math.log(20)) * (25 + 13 * load) + 5 * load);
            debug(4, `Waiting maximum ${wait} more seconds.`);

            if (this.stat.tired) GLib.Source.remove(this.stat.tired);
            this.stat.tired = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
                try {
                    debug(3, `Tired of waiting for launches...`);
                    this.current = new Desktop('current').windows;
                    this._finish_restore();
                } catch(error) {
                    debug(0, error);
                }
            });
        } else { // No pending launches
            if (this.stat.tired) GLib.Source.remove(this.stat.tired);
            this._finish_restore();
        }
    }

    _finish_restore() {
        global.display.disconnect(this.stat.created);
        this.stat.created = null; // Block obsolete events already in progress
        for (let event of Object.keys(this.stat.events)) {
            if (!this.stat.events[event]) {
                GLib.Source.remove(event);
            } else {
                this.stat.events[event].disconnect(event);
            }
        }

        // If there were launches, then there was enough time for the user to
        // have opened/closed windows in the interim; rematch:
        if (this.stat.tired) {
            this.match_by_id();
            this.match_by_properties();
        }
        this.restore_properties();
    }

    restore_properties() {
        debug(3, `Restoring window properties...`);

        this._focused = null;
        for (let restore of Object.values(this.restore).sort((a, b) => a.workspace - b.workspace)) {
            restore.match = restore.match || restore._match;
            if (!restore.match) continue;
            let current = this.current[restore.match];

            this._restore_window(restore, current);
        }

        let focused = this._focused;
        if (focused) {
            focused.window.activate(global.get_current_time());

            debug(2, `Focused window: ${focused.class} (${focused.id})`);
        }

        notify(_('Session restored'), _(`Restored session from ${opt.filename}`));
    }

    _restore_window(restore, current) {
        if (restore.workspace !== current.workspace) {
            let wsm = global.workspace_manager;
            for (let n = wsm.get_n_workspaces(); n <= restore.workspace; n++) {
                wsm.append_new_workspace(false, null);
            }

            current.window.change_workspace(wsm.get_workspace_by_index(restore.workspace));

            debug(2, `${current.class} (${current.id})`
                   + ` - moved workspace from ${current.workspace} => ${restore.workspace}`);
        }

        for (let state in restore.state) {
            if (restore.state[state] !== current.state[state]) {
                switch (state) {
                    case 'minimized':
                        restore.state[state] ? current.window.minimize() : current.window.unminimize();
                        break;
                    case 'maximized-horizontal':
                        restore.state[state] ? current.window.maximize(Meta.MaximizeFlags.HORIZONTAL) : current.window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
                        break;
                    case 'maximized-vertical':
                        restore.state[state] ? current.window.maximize(Meta.MaximizeFlags.VERTICAL) : current.window.unmaximize(Meta.MaximizeFlags.VERTICAL);
                        break;
                    case 'fullscreen':
                        restore.state[state] ? current.window.make_fullscreen() : current.window.unmake_fullscreen();
                        break;
                    case 'above':
                        restore.state[state] ? current.window.make_above() : current.window.unmake_above();
                        break;
                    case 'sticky':
                        restore.state[state] ? current.window.stick() : current.window.unstick();
                        break;
                    case 'focused':
                        if (restore.state[state]) this._focused = current;
                        break;
                }

                if (state !== 'focused') {
                    debug(2, `${current.class} (${current.id})`
                           + ` - ${state}: ${current.state[state]} => ${restore.state[state]}`);
                }
            }
        }

        this._apply_geometry(restore, current);
    }

    _apply_geometry(restore, current) {
        if (restore.geometry !== current.geometry) {
            current.window.move_resize_frame(true,
                restore.rect.x, restore.rect.y,
                restore.rect.width, restore.rect.height);

            debug(2, `${current.class} (${current.id})`
                   + ` - moved from ${current.geometry} => ${restore.geometry}`);
        }
    }
}
